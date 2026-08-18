const Transaction = require("../models/Transaction");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");

function registerAdminTransactionRoutes(app, getDbInitialized) {
    // List all transactions, across all users
    app.get("/api/admin/transactions", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const {
                page = 1,
                limit = 50,
                type,
                status,
                search,
                sortBy = 'createdAt',
                sortOrder = 'desc'
            } = req.query;

            const query = {};
            if (type) query.type = type;
            if (status) query.status = status;

            if (search) {
                const User = require("../models/User");
                const matchingUsers = await User.find({
                    $or: [
                        { name: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } }
                    ]
                }).select('_id');
                query.$or = [
                    { description: { $regex: search, $options: 'i' } },
                    { transactionId: { $regex: search, $options: 'i' } },
                    { userId: { $in: matchingUsers.map(u => u._id) } }
                ];
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

            const [transactions, total, paymentsAgg, invoicedAgg] = await Promise.all([
                Transaction.find(query)
                    .populate('userId', 'name email')
                    .sort(sort)
                    .skip(skip)
                    .limit(parseInt(limit)),
                Transaction.countDocuments(query),
                Transaction.aggregate([
                    { $match: { status: 'completed', type: 'payment' } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]),
                Transaction.aggregate([
                    { $match: { status: 'completed', type: 'invoice' } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ])
            ]);

            res.json({
                success: true,
                transactions: transactions.map(t => ({
                    id: t._id,
                    type: t.type,
                    amount: t.amount,
                    currency: t.currency,
                    status: t.status,
                    description: t.description,
                    paymentMethod: t.paymentMethod,
                    user: t.userId ? { id: t.userId._id, name: t.userId.name, email: t.userId.email } : null,
                    createdAt: t.createdAt
                })),
                summary: {
                    totalCompletedPayments: paymentsAgg[0]?.total || 0,
                    totalCompletedInvoiced: invoicedAgg[0]?.total || 0
                },
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'admin_list_transactions_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to list transactions", details: error.message });
        }
    });
}

module.exports = registerAdminTransactionRoutes;
