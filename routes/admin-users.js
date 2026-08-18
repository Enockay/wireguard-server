const crypto = require("crypto");
const User = require("../models/User");
const MikrotikRouter = require("../models/MikrotikRouter");
const Client = require("../models/Client");
const Transaction = require("../models/Transaction");
const Subscription = require("../models/Subscription");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");
const { releasePorts } = require("../utils/port-allocator");

function registerAdminUserRoutes(app, getDbInitialized) {
    // List / search / filter users
    app.get("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const {
                page = 1,
                limit = 50,
                search,
                role,
                isActive,
                sortBy = 'createdAt',
                sortOrder = 'desc'
            } = req.query;

            const query = {};
            if (role) query.role = role;
            if (isActive !== undefined) query.isActive = isActive === 'true';
            if (search) {
                query.$or = [
                    { name: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } }
                ];
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

            const [users, total] = await Promise.all([
                User.find(query).sort(sort).skip(skip).limit(parseInt(limit)),
                User.countDocuments(query)
            ]);

            res.json({
                success: true,
                users: users.map(u => u.toJSON()),
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'admin_list_users_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to list users", details: error.message });
        }
    });

    // Create a user directly (admin-initiated)
    app.post("/api/admin/users", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { email, password, name, role = 'user', isActive = true, emailVerified = true } = req.body;

            if (!email || !password || !name) {
                return res.status(400).json({ success: false, error: "Email, password, and name are required" });
            }
            if (password.length < 6) {
                return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
            }
            if (!['user', 'admin'].includes(role)) {
                return res.status(400).json({ success: false, error: "Invalid role" });
            }

            const existing = await User.findOne({ email: email.toLowerCase() });
            if (existing) {
                return res.status(409).json({ success: false, error: "A user with this email already exists" });
            }

            const referralCode = crypto.randomBytes(8).toString('hex').toUpperCase();
            const user = new User({
                email: email.toLowerCase(),
                password,
                name,
                role,
                isActive,
                emailVerified,
                referralCode
            });
            await user.save();

            res.status(201).json({ success: true, message: "User created successfully", user: user.toJSON() });
        } catch (error) {
            log('error', 'admin_create_user_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to create user", details: error.message });
        }
    });

    // Get a single user, with their routers and recent transactions
    app.get("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            const user = await User.findById(id);
            if (!user) {
                return res.status(404).json({ success: false, error: "User not found" });
            }

            const [routers, transactions] = await Promise.all([
                MikrotikRouter.find({ userId: id }).sort({ createdAt: -1 }),
                Transaction.find({ userId: id }).sort({ createdAt: -1 }).limit(20)
            ]);

            res.json({
                success: true,
                user: user.toJSON(),
                routers: routers.map(r => ({
                    id: r._id,
                    name: r.name,
                    status: r.status,
                    ports: r.ports,
                    lastSeen: r.lastSeen,
                    createdAt: r.createdAt
                })),
                transactions: transactions.map(t => ({
                    id: t._id,
                    type: t.type,
                    amount: t.amount,
                    currency: t.currency,
                    status: t.status,
                    description: t.description,
                    createdAt: t.createdAt
                }))
            });
        } catch (error) {
            log('error', 'admin_get_user_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to get user", details: error.message });
        }
    });

    // Update a user - name, email, role, isActive, or apply a balance adjustment
    app.patch("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { name, email, role, isActive, balanceAdjustment, balanceAdjustmentReason } = req.body;

            const user = await User.findById(id);
            if (!user) {
                return res.status(404).json({ success: false, error: "User not found" });
            }

            const isSelf = req.user.userId === id;

            if (role !== undefined) {
                if (!['user', 'admin'].includes(role)) {
                    return res.status(400).json({ success: false, error: "Invalid role" });
                }
                if (isSelf && role !== 'admin') {
                    return res.status(400).json({ success: false, error: "You cannot remove your own admin role" });
                }
                user.role = role;
            }

            if (isActive !== undefined) {
                if (isSelf && isActive === false) {
                    return res.status(400).json({ success: false, error: "You cannot deactivate your own account" });
                }
                user.isActive = isActive;
            }

            if (name !== undefined) user.name = name;
            if (email !== undefined) user.email = email.toLowerCase();

            if (balanceAdjustment !== undefined) {
                const amount = Number(balanceAdjustment);
                if (Number.isNaN(amount) || amount === 0) {
                    return res.status(400).json({ success: false, error: "balanceAdjustment must be a non-zero number" });
                }
                const newBalance = user.balance + amount;
                if (newBalance < 0) {
                    return res.status(400).json({ success: false, error: "Adjustment would result in a negative balance" });
                }
                user.balance = newBalance;

                const transaction = new Transaction({
                    userId: user._id,
                    type: amount > 0 ? 'payment' : 'refund',
                    transactionId: `admin-adj-${crypto.randomBytes(8).toString('hex')}`,
                    amount: Math.abs(amount),
                    currency: user.currency,
                    description: balanceAdjustmentReason || `Manual balance adjustment by admin (${req.user.email})`,
                    status: 'completed',
                    paymentMethod: 'manual',
                    metadata: { adjustedBy: req.user.userId, direction: amount > 0 ? 'credit' : 'debit' }
                });
                await transaction.save();
            }

            await user.save();

            res.json({ success: true, message: "User updated successfully", user: user.toJSON() });
        } catch (error) {
            if (error.code === 11000) {
                return res.status(409).json({ success: false, error: "A user with this email already exists" });
            }
            log('error', 'admin_update_user_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to update user", details: error.message });
        }
    });

    // Delete a user, cascading their routers/clients/subscriptions so we
    // don't leave orphaned records behind (the exact problem the admin
    // router view surfaced for pre-existing data).
    app.delete("/api/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            if (req.user.userId === id) {
                return res.status(400).json({ success: false, error: "You cannot delete your own account" });
            }

            const user = await User.findById(id);
            if (!user) {
                return res.status(404).json({ success: false, error: "User not found" });
            }

            const routers = await MikrotikRouter.find({ userId: id });
            const { stopRouterProxy } = require("../services/tcp-proxy-service");

            for (const router of routers) {
                try {
                    stopRouterProxy(router._id);
                } catch (proxyError) {
                    log('warn', 'admin_delete_user_proxy_stop_failed', { routerId: router._id, error: proxyError.message });
                }
                await releasePorts(router._id);
                if (router.wireguardClientId) {
                    await Client.findByIdAndDelete(router.wireguardClientId);
                }
                await Subscription.deleteOne({ routerId: router._id });
                await router.deleteOne();
            }

            await user.deleteOne();

            res.json({
                success: true,
                message: "User deleted successfully",
                deletedRouters: routers.length
            });
        } catch (error) {
            log('error', 'admin_delete_user_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to delete user", details: error.message });
        }
    });
}

module.exports = registerAdminUserRoutes;
