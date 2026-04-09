const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
    ROOT,
    withMockedModules
} = require('./helpers/test-kit');

const modulePath = path.join(ROOT, 'middleware/admin-auth.js');

function loadMiddleware({ adminUser } = {}) {
    return withMockedModules({
        'models/User.js': {
            async findById() {
                return adminUser || {
                    _id: 'admin-1',
                    role: 'admin',
                    adminRole: null
                };
            }
        },
        'routes/auth.js': {
            authenticateToken(req, res, next) {
                const auth = req.headers.authorization;
                if (!auth) {
                    return res.status(401).json({ success: false, error: 'Authentication token required' });
                }
                if (auth === 'Bearer invalid') {
                    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
                }
                req.user = { userId: 'admin-1' };
                return next();
            }
        }
    }, () => {
        delete require.cache[modulePath];
        return require(modulePath);
    });
}

function createReq(headers = {}) {
    return {
        headers,
        user: null
    };
}

function createRes() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

test('hasAdminPermission respects scoped admin roles and unrestricted super admins', async () => {
    const { hasAdminPermission } = await loadMiddleware();

    assert.equal(hasAdminPermission({ role: 'admin', adminRole: null }, 'admin.routers.run_command'), true);
    assert.equal(hasAdminPermission({ role: 'admin', adminRole: 'super_admin' }, 'admin.billing.issue_refund'), true);
    assert.equal(hasAdminPermission({ role: 'admin', adminRole: 'support_admin' }, 'admin.support.reply'), true);
    assert.equal(hasAdminPermission({ role: 'admin', adminRole: 'support_admin' }, 'admin.routers.run_command'), false);
    assert.equal(hasAdminPermission({ role: 'admin', adminRole: 'read_only' }, 'admin.monitoring.view_overview'), true);
    assert.equal(hasAdminPermission({ role: 'admin', adminRole: 'read_only' }, 'admin.support.reply'), false);
});

test('requireAdminPermission blocks authenticated admins without the required scoped permission', async () => {
    const { requireAdminPermission } = await loadMiddleware({
        adminUser: {
            _id: 'admin-1',
            role: 'admin',
            adminRole: 'support_admin'
        }
    });

    const req = createReq({ authorization: 'Bearer admin' });
    const res = createRes();
    let nextCalled = false;

    await requireAdminPermission('admin.routers.run_command')(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.error, 'You do not have permission to perform this action');
});
