const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDoc,
    createFlagSubdoc,
    createPermissionProxy,
    createRouteTestContext,
    createSubdocCollection,
    withRouteApp
} = require('./helpers/test-kit');

const routeModulePath = 'routes/admin-users.js';

function createUserRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const targetUser = overrides.targetUser || createDoc({
        _id: '507f1f77bcf86cd799439021',
        email: 'customer@test.local',
        emailVerified: false,
        isActive: true,
        adminNotes: [],
        internalFlags: createSubdocCollection([]),
        generateVerificationToken() {
            this.emailVerificationToken = 'verify-token';
            return 'verify-token';
        },
        generatePasswordResetToken() {
            this.passwordResetToken = 'reset-token';
            return 'reset-token';
        }
    });

    const service = {
        ADMIN_PERMISSIONS: createPermissionProxy(),
        NOTE_CATEGORIES: ['support', 'billing'],
        FLAG_TYPES: ['vip', 'manual_review'],
        FLAG_SEVERITIES: ['low', 'medium', 'high'],
        buildRiskStatus: (user) => user.riskStatus || 'normal',
        async getAdminUserStats() {
            return { total: 1, active: 1 };
        },
        async listAdminUsers() {
            return {
                items: [{ id: targetUser._id, email: targetUser.email }],
                pagination: { page: 1, limit: 20, total: 1, pages: 1 }
            };
        },
        async getAdminUserDetail() {
            return { id: targetUser._id, email: targetUser.email };
        },
        async getAdminUserServices() {
            return { routers: 1, monitoring: true };
        },
        async getAdminUserRouters() {
            return { items: [{ id: 'router-1' }], summary: { total: 1 } };
        },
        async getAdminUserBilling() {
            return { status: 'trialing' };
        },
        async getAdminUserActivity() {
            return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } };
        },
        async getAdminUserSecurity() {
            return { sessions: 1 };
        },
        async getAdminUserSupport() {
            return {
                summary: { openTickets: 1 },
                items: [{ id: 'ticket-1' }],
                pagination: { page: 1, limit: 20, total: 1, pages: 1 }
            };
        },
        async getAdminUserNotes() {
            return [{ body: 'note-1' }];
        },
        async getAdminUserFlags() {
            return { riskStatus: 'normal', items: [{ flag: 'vip' }] };
        },
        ...overrides.service
    };

    const userModel = {
        async findById(id) {
            return id === targetUser._id ? targetUser : null;
        },
        ...overrides.userModel
    };

    return {
        ctx,
        targetUser,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/email-service.js': ctx.emailService,
            'services/security-event-service.js': ctx.securityService,
            'services/admin-user-service.js': service,
            'models/User.js': userModel
        }
    };
}

async function exerciseAdminAuth(path, method = 'GET', body) {
    const { mocks } = createUserRouteMocks();

    return withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const unauthenticated = await request(method, path, { token: null, body });
        assert.equal(unauthenticated.response.status, 401);
        assert.equal(unauthenticated.json.error, 'Authentication required');

        const invalid = await request(method, path, { token: 'invalid', body });
        assert.equal(invalid.response.status, 401);
        assert.equal(invalid.json.error, 'Invalid authentication token');

        const forbidden = await request(method, path, { token: 'user', body });
        assert.equal(forbidden.response.status, 403);
        assert.equal(forbidden.json.error, 'Admin access required');
    });
}

test('admin users routes enforce authentication and admin role', async () => {
    await exerciseAdminAuth('/api/admin/users/stats');
    await exerciseAdminAuth('/api/admin/users/507f1f77bcf86cd799439021/notes', 'POST', { body: 'hello' });
    await exerciseAdminAuth('/api/admin/users/507f1f77bcf86cd799439021/force-logout', 'POST', { reason: 'security review' });
});

test('admin users list, stats, detail and related data endpoints return expected payloads', async () => {
    const { mocks, targetUser } = createUserRouteMocks();

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const stats = await request('GET', '/api/admin/users/stats');
        assert.equal(stats.response.status, 200);
        assert.deepEqual(stats.json.stats, { total: 1, active: 1 });

        const list = await request('GET', '/api/admin/users?q=customer&page=2');
        assert.equal(list.response.status, 200);
        assert.equal(list.json.items[0].id, targetUser._id);
        assert.equal(list.json.pagination.total, 1);

        const detail = await request('GET', `/api/admin/users/${targetUser._id}`);
        assert.equal(detail.response.status, 200);
        assert.equal(detail.json.data.id, targetUser._id);

        const services = await request('GET', `/api/admin/users/${targetUser._id}/services`);
        assert.equal(services.response.status, 200);
        assert.equal(services.json.services.routers, 1);

        const routers = await request('GET', `/api/admin/users/${targetUser._id}/routers`);
        assert.equal(routers.response.status, 200);
        assert.equal(routers.json.summary.total, 1);

        const billing = await request('GET', `/api/admin/users/${targetUser._id}/billing`);
        assert.equal(billing.response.status, 200);
        assert.equal(billing.json.billing.status, 'trialing');

        const activity = await request('GET', `/api/admin/users/${targetUser._id}/activity`);
        assert.equal(activity.response.status, 200);
        assert.equal(activity.json.items.length, 1);

        const security = await request('GET', `/api/admin/users/${targetUser._id}/security`);
        assert.equal(security.response.status, 200);
        assert.equal(security.json.security.sessions, 1);

        const support = await request('GET', `/api/admin/users/${targetUser._id}/support`);
        assert.equal(support.response.status, 200);
        assert.equal(support.json.summary.openTickets, 1);

        const notes = await request('GET', `/api/admin/users/${targetUser._id}/notes`);
        assert.equal(notes.response.status, 200);
        assert.equal(notes.json.items[0].body, 'note-1');

        const flags = await request('GET', `/api/admin/users/${targetUser._id}/flags`);
        assert.equal(flags.response.status, 200);
        assert.equal(flags.json.riskStatus, 'normal');
    });
});

test('admin users detail endpoints return 404 when the user bundle is missing', async () => {
    const { mocks } = createUserRouteMocks({
        service: {
            async getAdminUserDetail() { return null; },
            async getAdminUserServices() { return null; },
            async getAdminUserRouters() { return null; },
            async getAdminUserBilling() { return null; },
            async getAdminUserActivity() { return null; },
            async getAdminUserSecurity() { return null; },
            async getAdminUserSupport() { return null; },
            async getAdminUserNotes() { return null; },
            async getAdminUserFlags() { return null; }
        }
    });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        for (const endpoint of [
            '/api/admin/users/missing-id',
            '/api/admin/users/missing-id/services',
            '/api/admin/users/missing-id/routers',
            '/api/admin/users/missing-id/billing',
            '/api/admin/users/missing-id/activity',
            '/api/admin/users/missing-id/security',
            '/api/admin/users/missing-id/support',
            '/api/admin/users/missing-id/notes',
            '/api/admin/users/missing-id/flags'
        ]) {
            const res = await request('GET', endpoint);
            assert.equal(res.response.status, 404, endpoint);
        }
    });
});

test('admin users notes validate payloads and persist note plus audit entry', async () => {
    const { mocks, targetUser, ctx } = createUserRouteMocks();

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const missingBody = await request('POST', `/api/admin/users/${targetUser._id}/notes`, { body: {} });
        assert.equal(missingBody.response.status, 400);
        assert.equal(missingBody.json.error, 'Note body is required');

        const invalidCategory = await request('POST', `/api/admin/users/${targetUser._id}/notes`, {
            body: { body: 'hello', category: 'invalid' }
        });
        assert.equal(invalidCategory.response.status, 400);
        assert.equal(invalidCategory.json.error, 'Invalid note category');

        const created = await request('POST', `/api/admin/users/${targetUser._id}/notes`, {
            body: { body: 'Follow up now', category: 'support', pinned: true, reason: 'case review' }
        });

        assert.equal(created.response.status, 200);
        assert.equal(created.json.message, 'Note added successfully');
        assert.equal(targetUser.adminNotes.length, 1);
        assert.equal(targetUser.adminNotes[0].body, 'Follow up now');
        assert.equal(targetUser.adminNotes[0].author, 'admin@test.local');
        assert.equal(targetUser.saveCalls, 1);
        assert.equal(ctx.auditCalls.length, 1);
        assert.equal(ctx.auditCalls[0].action, 'admin.users.add_note');
    });
});

test('admin users flags validate, persist, remove, and update risk state', async () => {
    const existingFlag = createFlagSubdoc({ _id: 'flag-1', flag: 'vip', severity: 'high', description: 'important' });
    const userWithFlag = createDoc({
        _id: '507f1f77bcf86cd799439031',
        internalFlags: createSubdocCollection([existingFlag]),
        riskStatus: 'flagged',
        adminNotes: []
    });
    const { mocks, targetUser, ctx } = createUserRouteMocks({ targetUser: userWithFlag });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const invalidType = await request('POST', `/api/admin/users/${targetUser._id}/flags`, { body: { flag: 'bad' } });
        assert.equal(invalidType.response.status, 400);

        const invalidSeverity = await request('POST', `/api/admin/users/${targetUser._id}/flags`, {
            body: { flag: 'vip', severity: 'critical' }
        });
        assert.equal(invalidSeverity.response.status, 400);

        const created = await request('POST', `/api/admin/users/${targetUser._id}/flags`, {
            body: { flag: 'manual_review', severity: 'high', description: 'watch closely', reason: 'risk' }
        });
        assert.equal(created.response.status, 200);
        assert.equal(targetUser.internalFlags.length, 2);
        assert.equal(targetUser.riskStatus, 'flagged');

        const missing = await request('DELETE', `/api/admin/users/${targetUser._id}/flags/unknown`, { body: { reason: 'cleanup' } });
        assert.equal(missing.response.status, 404);

        const removed = await request('DELETE', `/api/admin/users/${targetUser._id}/flags/flag-1`, { body: { reason: 'resolved' } });
        assert.equal(removed.response.status, 200);
        assert.equal(existingFlag.deleted, true);
        assert.equal(ctx.auditCalls.at(-1).action, 'admin.users.remove_flag');
    });
});

test('admin users status, verification, password reset, force logout, and trial extension actions persist side effects', async () => {
    const { mocks, targetUser, ctx } = createUserRouteMocks();

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const suspended = await request('POST', `/api/admin/users/${targetUser._id}/suspend`, { body: { reason: 'abuse' } });
        assert.equal(suspended.response.status, 200);
        assert.equal(targetUser.isActive, false);
        assert.ok(targetUser.sessionsRevokedAt);

        const reactivated = await request('POST', `/api/admin/users/${targetUser._id}/reactivate`, { body: { reason: 'cleared' } });
        assert.equal(reactivated.response.status, 200);
        assert.equal(targetUser.isActive, true);

        const verified = await request('POST', `/api/admin/users/${targetUser._id}/verify`, { body: { reason: 'manual check' } });
        assert.equal(verified.response.status, 200);
        assert.equal(targetUser.emailVerified, true);
        assert.ok(targetUser.emailVerifiedAt);

        targetUser.emailVerified = true;
        const alreadyVerified = await request('POST', `/api/admin/users/${targetUser._id}/resend-verification`, { body: { reason: 'retry' } });
        assert.equal(alreadyVerified.response.status, 400);
        targetUser.emailVerified = false;

        const resent = await request('POST', `/api/admin/users/${targetUser._id}/resend-verification`, { body: { reason: 'retry' } });
        assert.equal(resent.response.status, 200);
        assert.equal(ctx.emailCalls.at(-1).type, 'verification');

        const passwordReset = await request('POST', `/api/admin/users/${targetUser._id}/send-password-reset`, { body: { reason: 'secure account' } });
        assert.equal(passwordReset.response.status, 200);
        assert.equal(ctx.emailCalls.at(-1).type, 'password-reset');
        assert.equal(ctx.securityCalls.at(-1).type, 'security-event');

        const forceLogout = await request('POST', `/api/admin/users/${targetUser._id}/force-logout`, { body: { reason: 'session review' } });
        assert.equal(forceLogout.response.status, 200);
        assert.equal(ctx.securityCalls.some((entry) => entry.type === 'revoke-all'), true);

        const invalidDays = await request('POST', `/api/admin/users/${targetUser._id}/extend-trial`, { body: { days: 'invalid' } });
        assert.equal(invalidDays.response.status, 400);

        const extended = await request('POST', `/api/admin/users/${targetUser._id}/extend-trial`, { body: { days: 5, reason: 'conversion follow up' } });
        assert.equal(extended.response.status, 200);
        assert.ok(extended.json.trialEndsAt);
        assert.equal(ctx.auditCalls.at(-1).action, 'admin.users.extend_trial');
    });
});
