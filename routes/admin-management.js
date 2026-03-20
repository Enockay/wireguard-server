const User = require('../models/User');
const { requireAdmin } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');

const ADMIN_ROLE_VALUES = ['super_admin', 'network_admin', 'billing_admin', 'support_admin', 'read_only'];

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function serializeAdmin(user) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        adminRole: user.adminRole || null,
        isActive: Boolean(user.isActive),
        lastLoginAt: user.lastLoginAt || null,
        createdAt: user.createdAt
    };
}

function canManageAdmins(adminUser) {
    return adminUser?.adminRole === 'super_admin' || !adminUser?.adminRole;
}

async function audit(req, targetUserId, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId,
        action,
        reason,
        metadata
    });
}

function registerAdminManagementRoutes(app) {
    app.get('/api/admin/management/admins', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admins = await User.find({ role: 'admin' })
                .select('name email adminRole isActive lastLoginAt createdAt')
                .sort({ createdAt: -1 })
                .lean();

            return res.json({
                success: true,
                items: admins.map((admin) => serializeAdmin(admin))
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load admin accounts', details: error.message });
        }
    });

    app.post('/api/admin/management/admins', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const name = String(req.body?.name || '').trim();
            const email = String(req.body?.email || '').trim().toLowerCase();
            const password = String(req.body?.password || '');
            const adminRole = String(req.body?.adminRole || '').trim();

            if (!name || !email || password.length < 6 || !ADMIN_ROLE_VALUES.includes(adminRole)) {
                return res.status(400).json({ success: false, error: 'name, email, password (min 6 chars), and a valid adminRole are required' });
            }

            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return res.status(409).json({ success: false, error: 'An account with this email already exists' });
            }

            const admin = await User.create({
                name,
                email,
                password,
                role: 'admin',
                adminRole,
                isActive: true,
                emailVerified: true,
                emailVerifiedAt: new Date()
            });

            await audit(req, admin._id, 'admin_create_admin_account', normalizeReason(req.body?.reason), {
                email: admin.email,
                adminRole: admin.adminRole
            });

            return res.status(201).json({ success: true, admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create admin account', details: error.message });
        }
    });

    app.put('/api/admin/management/admins/:id', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            if (String(admin._id) === String(req.adminUser._id) && Object.prototype.hasOwnProperty.call(req.body || {}, 'adminRole')) {
                return res.status(403).json({ success: false, error: 'You cannot change your own role' });
            }

            const changed = {};
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
                const nextName = String(req.body?.name || '').trim();
                if (!nextName) {
                    return res.status(400).json({ success: false, error: 'Name cannot be empty' });
                }
                admin.name = nextName;
                changed.name = nextName;
            }

            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'adminRole')) {
                const nextRole = String(req.body?.adminRole || '').trim();
                if (!ADMIN_ROLE_VALUES.includes(nextRole)) {
                    return res.status(400).json({ success: false, error: 'Invalid adminRole provided' });
                }
                admin.adminRole = nextRole;
                changed.adminRole = nextRole;
            }

            if (!Object.keys(changed).length) {
                return res.status(400).json({ success: false, error: 'No changes provided' });
            }

            await admin.save();
            await audit(req, admin._id, 'admin_update_admin_account', normalizeReason(req.body?.reason), changed);

            return res.json({ success: true, admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update admin account', details: error.message });
        }
    });

    app.post('/api/admin/management/admins/:id/deactivate', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            if (String(req.params.id) === String(req.adminUser._id)) {
                return res.status(403).json({ success: false, error: 'You cannot deactivate your own account' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            admin.isActive = false;
            await admin.save();
            await audit(req, admin._id, 'admin_deactivate_admin_account', normalizeReason(req.body?.reason), { email: admin.email });
            return res.json({ success: true, message: 'Admin account deactivated', admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to deactivate admin account', details: error.message });
        }
    });

    app.post('/api/admin/management/admins/:id/activate', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            admin.isActive = true;
            await admin.save();
            await audit(req, admin._id, 'admin_activate_admin_account', normalizeReason(req.body?.reason), { email: admin.email });
            return res.json({ success: true, message: 'Admin account activated', admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to activate admin account', details: error.message });
        }
    });

    app.delete('/api/admin/management/admins/:id', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            if (String(req.params.id) === String(req.adminUser._id)) {
                return res.status(403).json({ success: false, error: 'You cannot delete your own account' });
            }

            const reason = normalizeReason(req.body?.reason);
            if (!reason) {
                return res.status(400).json({ success: false, error: 'A deletion reason is required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            await audit(req, admin._id, 'admin_delete_admin_account', reason, { email: admin.email, adminRole: admin.adminRole });
            await User.deleteOne({ _id: admin._id });
            return res.json({ success: true, message: 'Admin account deleted' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete admin account', details: error.message });
        }
    });
}

module.exports = registerAdminManagementRoutes;
