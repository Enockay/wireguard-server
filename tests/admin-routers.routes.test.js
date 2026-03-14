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

const routeModulePath = 'routes/admin-routers.js';

function createRouterRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const router = overrides.router || createDoc({
        _id: '507f1f77bcf86cd799439041',
        name: 'RTR-1',
        serverNode: 'wireguard',
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });

    const service = {
        ADMIN_ROUTER_PERMISSIONS: createPermissionProxy(),
        ROUTER_NOTE_CATEGORIES: ['support', 'provisioning'],
        ROUTER_FLAG_TYPES: ['manual_review', 'unstable'],
        ROUTER_FLAG_SEVERITIES: ['low', 'medium', 'high'],
        async listAdminRouters() {
            return { items: [{ id: router._id }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } };
        },
        async getAdminRouterStats() { return { total: 1, online: 1 }; },
        async getAdminRouterDetail() { return { id: router._id, name: router.name }; },
        async getAdminRouterConnectivity() { return { status: 'online' }; },
        async getAdminRouterPorts() { return { ssh: 2201 }; },
        async getAdminRouterMonitoring() { return { health: 'healthy' }; },
        async getAdminRouterActivity() { return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminRouterProvisioning() { return { state: 'ready' }; },
        async getAdminRouterDiagnostics() { return { issues: [] }; },
        async getAdminRouterNotes() { return [{ body: 'router-note' }]; },
        async getAdminRouterFlags() { return [{ flag: 'manual_review' }]; },
        async disableRouter() { return { router }; },
        async reactivateRouter() { return { router }; },
        async reprovisionRouter() { return { router }; },
        async generateRouterSetupArtifacts() { return { generatedAt: '2026-03-14T00:00:00.000Z' }; },
        async resetRouterPeer() { return { generatedAt: '2026-03-14T00:00:00.000Z' }; },
        async reassignRouterPorts() { return { previousPorts: { ssh: 2201 }, ports: { ssh: 2202 } }; },
        async markRouterProvisioningReviewed() { return { provisioningReviewedAt: '2026-03-14T00:00:00.000Z' }; },
        async deleteRouterAdmin() { return { deleted: true }; },
        ...overrides.service
    };

    const routerModel = {
        findById(id) {
            return {
                async populate() {
                    return id === router._id ? router : null;
                }
            };
        },
        ...overrides.routerModel
    };

    return {
        ctx,
        router,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/admin-router-service.js': service,
            'models/MikrotikRouter.js': routerModel
        }
    };
}

test('admin router routes enforce authentication and admin role', async () => {
    const { mocks } = createRouterRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        for (const [method, path, body] of [
            ['GET', '/api/admin/routers/stats'],
            ['GET', '/api/admin/routers/507f1f77bcf86cd799439041'],
            ['POST', '/api/admin/routers/507f1f77bcf86cd799439041/disable', { reason: 'offline' }]
        ]) {
            const unauth = await request(method, path, { token: null, body });
            assert.equal(unauth.response.status, 401);
            const forbidden = await request(method, path, { token: 'user', body });
            assert.equal(forbidden.response.status, 403);
        }
    });
});

test('admin router read endpoints return expected payloads and 404 when not found', async () => {
    const { mocks, router } = createRouterRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        for (const path of [
            '/api/admin/routers/stats',
            '/api/admin/routers',
            `/api/admin/routers/${router._id}`,
            `/api/admin/routers/${router._id}/connectivity`,
            `/api/admin/routers/${router._id}/ports`,
            `/api/admin/routers/${router._id}/monitoring`,
            `/api/admin/routers/${router._id}/activity`,
            `/api/admin/routers/${router._id}/provisioning`,
            `/api/admin/routers/${router._id}/diagnostics`,
            `/api/admin/routers/${router._id}/notes`,
            `/api/admin/routers/${router._id}/flags`
        ]) {
            const res = await request('GET', path);
            assert.equal(res.response.status, 200, path);
        }
    });

    const missing = createRouterRouteMocks({
        service: {
            async getAdminRouterDetail() { return null; },
            async getAdminRouterConnectivity() { return null; },
            async getAdminRouterPorts() { return null; },
            async getAdminRouterMonitoring() { return null; },
            async getAdminRouterActivity() { return null; },
            async getAdminRouterProvisioning() { return null; },
            async getAdminRouterDiagnostics() { return null; },
            async getAdminRouterNotes() { return null; },
            async getAdminRouterFlags() { return null; }
        }
    });

    await withRouteApp({ routeModulePath, mocks: missing.mocks }, async ({ request }) => {
        for (const path of [
            '/api/admin/routers/missing',
            '/api/admin/routers/missing/connectivity',
            '/api/admin/routers/missing/ports',
            '/api/admin/routers/missing/monitoring',
            '/api/admin/routers/missing/activity',
            '/api/admin/routers/missing/provisioning',
            '/api/admin/routers/missing/diagnostics',
            '/api/admin/routers/missing/notes',
            '/api/admin/routers/missing/flags'
        ]) {
            const res = await request('GET', path);
            assert.equal(res.response.status, 404, path);
        }
    });
});

test('admin router notes and flags validate and create audit entries', async () => {
    const flag = createFlagSubdoc({ _id: 'router-flag', flag: 'manual_review', severity: 'medium', description: 'desc' });
    const router = createDoc({
        _id: '507f1f77bcf86cd799439051',
        name: 'RTR-2',
        serverNode: 'wireguard',
        adminNotes: [],
        internalFlags: createSubdocCollection([flag])
    });
    const { mocks, ctx } = createRouterRouteMocks({ router });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/notes`, { body: { body: 'x', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/notes`, { body: { body: 'Investigate', category: 'support', reason: 'ops' } })).response.status, 200);
        assert.equal(router.adminNotes.length, 1);

        assert.equal((await request('POST', `/api/admin/routers/${router._id}/flags`, { body: { flag: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/flags`, { body: { flag: 'manual_review', severity: 'critical' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/flags`, { body: { flag: 'unstable', severity: 'high', reason: 'review' } })).response.status, 200);
        assert.equal((await request('DELETE', `/api/admin/routers/${router._id}/flags/router-flag`, { body: { reason: 'resolved' } })).response.status, 200);
        assert.equal(flag.deleted, true);
        assert.ok(ctx.auditCalls.length >= 3);
    });
});

test('admin router action endpoints return expected statuses including move conflict', async () => {
    const { mocks, router, ctx } = createRouterRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/disable`, { body: { reason: 'incident' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/reactivate`, { body: { reason: 'recovered' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/reprovision`, { body: { reason: 'refresh' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/regenerate-setup`, { body: { reason: 'refresh' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/reset-peer`, { body: { reason: 'keys' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/routers/${router._id}/reassign-ports`, { body: { reason: 'conflict' } })).response.status, 200);

        const move = await request('POST', `/api/admin/routers/${router._id}/move-server`, { body: { reason: 'rebalance' } });
        assert.equal(move.response.status, 409);
        assert.match(move.json.error, /not supported/i);

        const reviewed = await request('POST', `/api/admin/routers/${router._id}/mark-reviewed`, { body: { reason: 'checked' } });
        assert.equal(reviewed.response.status, 200);

        const deleted = await request('DELETE', `/api/admin/routers/${router._id}`, { body: { reason: 'cleanup' } });
        assert.equal(deleted.response.status, 200);
        assert.ok(ctx.auditCalls.some((call) => call.action === 'admin.routers.delete'));
    });
});
