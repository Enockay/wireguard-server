const User = require('../models/User');
const { authenticateToken } = require('../routes/auth');

function requireAdmin(req, res, next) {
    return authenticateToken(req, res, async () => {
        try {
            const adminUser = await User.findById(req.user.userId);
            if (!adminUser || adminUser.role !== 'admin') {
                return res.status(403).json({ success: false, error: 'Admin access required' });
            }

            req.adminUser = adminUser;
            next();
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to validate admin access', details: error.message });
        }
    });
}

function requireAdminPermission(permission) {
    return (req, res, next) => requireAdmin(req, res, () => {
        req.adminPermission = permission;
        next();
    });
}

module.exports = {
    requireAdmin,
    requireAdminPermission
};
