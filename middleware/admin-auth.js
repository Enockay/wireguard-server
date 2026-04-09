const User = require('../models/User');
const { authenticateToken } = require('../routes/auth');

const ADMIN_ROLE_PERMISSION_RULES = {
    super_admin: ['*'],
    network_admin: [
        'admin.routers.',
        'admin.vpn_servers.',
        'admin.monitoring.',
        'admin.logs.',
        'admin.audit.',
        'admin.security.'
    ],
    billing_admin: [
        'admin.billing.',
        'admin.users.view',
        'admin.users.view_details',
        'admin.users.view_billing',
        'admin.users.add_note',
        'admin.users.flag',
        'admin.logs.',
        'admin.audit.',
        'admin.security.'
    ],
    support_admin: [
        'admin.support.',
        'admin.users.view',
        'admin.users.view_details',
        'admin.users.view_support',
        'admin.users.add_note',
        'admin.users.flag',
        'admin.logs.',
        'admin.audit.',
        'admin.security.'
    ],
    read_only: [
        'admin.users.view',
        'admin.users.view_details',
        'admin.users.view_billing',
        'admin.users.view_security',
        'admin.users.view_support',
        'admin.routers.view',
        'admin.routers.view_details',
        'admin.routers.view_connectivity',
        'admin.routers.view_monitoring',
        'admin.routers.view_billing_context',
        'admin.vpn_servers.view',
        'admin.vpn_servers.view_details',
        'admin.vpn_servers.view_health',
        'admin.vpn_servers.view_peers',
        'admin.monitoring.view',
        'admin.monitoring.view_',
        'admin.billing.view',
        'admin.billing.view_',
        'admin.logs.view_',
        'admin.audit.',
        'admin.security.',
        'admin.support.view',
        'admin.support.view_'
    ]
};

function hasAdminPermission(adminUser, permission) {
    if (!permission) return true;
    if (!adminUser || adminUser.role !== 'admin') return false;
    if (!adminUser.adminRole || adminUser.adminRole === 'super_admin') return true;

    const rules = ADMIN_ROLE_PERMISSION_RULES[adminUser.adminRole] || [];
    return rules.some((rule) => rule === '*' || permission === rule || permission.startsWith(rule));
}

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
        if (!hasAdminPermission(req.adminUser, permission)) {
            return res.status(403).json({ success: false, error: 'You do not have permission to perform this action' });
        }
        req.adminPermission = permission;
        return next();
    });
}

module.exports = {
    requireAdmin,
    requireAdminPermission,
    hasAdminPermission
};
