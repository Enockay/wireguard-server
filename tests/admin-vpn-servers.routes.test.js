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

const routeModulePath = 'routes/admin-vpn-servers.js';

function createVpnRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const server = overrides.server || createDoc({
        _id: '507f1f77bcf86cd799439061',
        nodeId: 'wg-1',
        name: 'Primary',
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });

    const service = {
        ADMIN_VPN_SERVER_PERMISSIONS: createPermissionProxy(),
        VPN_SERVER_NOTE_CATEGORIES: ['infrastructure', 'maintenance'],
        VPN_SERVER_FLAG_TYPES: ['overloaded', 'manual_review'],
        VPN_SERVER_FLAG_SEVERITIES: ['low', 'medium', 'high'],
        async listAdminVpnServers() { return { items: [{ id: server._id }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminVpnServerStats() { return { total: 1, healthy: 1 }; },
        async getAdminVpnServerDetail() { return { id: server._id }; },
        async getAdminVpnServerHealth() { return { status: 'healthy' }; },
        async getAdminVpnServerRouters() { return { items: [{ id: 'router-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminVpnServerPeers() { return { items: [{ id: 'peer-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminVpnServerTraffic() { return { rx: 10, tx: 5 }; },
        async getAdminVpnServerActivity() { return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminVpnServerDiagnostics() { return { issues: [] }; },
        async getAdminVpnServerNotes() { return [{ body: 'note' }]; },
        async getAdminVpnServerFlags() { return [{ flag: 'manual_review' }]; },
        async addVpnServer(payload) { return { _id: 'new-server', nodeId: payload.nodeId, controlMode: 'manual' }; },
        async disableVpnServer() { return server; },
        async reactivateVpnServer() { return server; },
        async setVpnServerMaintenance() { return server; },
        async restartVpnServer() { server.lastRestartAt = '2026-03-14T00:00:00.000Z'; return server; },
        async reconcileVpnServer() { server.lastReconcileAt = '2026-03-14T00:00:00.000Z'; return server; },
        async markVpnServerReviewed() { return { reviewedAt: '2026-03-14T00:00:00.000Z' }; },
        async migrateRoutersBetweenServers() { return { routersMigrated: ['r1'], targetServerId: 'target-1' }; },
        ...overrides.service
    };

    const model = {
        async findById(id) { return id === server._id ? server : null; },
        ...overrides.model
    };

    return {
        ctx,
        server,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/admin-vpn-server-service.js': service,
            'models/VpnServer.js': model
        }
    };
}

test('admin vpn server routes enforce auth and admin role', async () => {
    const { mocks } = createVpnRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const unauth = await request('GET', '/api/admin/vpn-servers/stats', { token: null });
        assert.equal(unauth.response.status, 401);
        const forbidden = await request('POST', '/api/admin/vpn-servers', { token: 'user', body: { nodeId: 'wg-2', name: 'Secondary' } });
        assert.equal(forbidden.response.status, 403);
    });
});

test('admin vpn server read endpoints and add server flow return expected payloads', async () => {
    const { mocks, server } = createVpnRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        for (const path of [
            '/api/admin/vpn-servers/stats',
            '/api/admin/vpn-servers',
            `/api/admin/vpn-servers/${server._id}`,
            `/api/admin/vpn-servers/${server._id}/health`,
            `/api/admin/vpn-servers/${server._id}/routers`,
            `/api/admin/vpn-servers/${server._id}/peers`,
            `/api/admin/vpn-servers/${server._id}/traffic`,
            `/api/admin/vpn-servers/${server._id}/activity`,
            `/api/admin/vpn-servers/${server._id}/diagnostics`,
            `/api/admin/vpn-servers/${server._id}/notes`,
            `/api/admin/vpn-servers/${server._id}/flags`
        ]) {
            const res = await request('GET', path);
            assert.equal(res.response.status, 200, path);
        }

        const invalidCreate = await request('POST', '/api/admin/vpn-servers', { body: { name: 'Missing node' } });
        assert.equal(invalidCreate.response.status, 400);

        const created = await request('POST', '/api/admin/vpn-servers', { body: { nodeId: 'wg-2', name: 'Secondary', reason: 'expansion' } });
        assert.equal(created.response.status, 201);
    });
});

test('admin vpn server notes, flags, and state transitions handle validation, conflicts, and audits', async () => {
    const flag = createFlagSubdoc({ _id: 'server-flag', flag: 'overloaded', severity: 'medium', description: 'busy' });
    const server = createDoc({
        _id: '507f1f77bcf86cd799439071',
        nodeId: 'wg-3',
        name: 'Tertiary',
        adminNotes: [],
        internalFlags: createSubdocCollection([flag])
    });
    const { mocks, ctx } = createVpnRouteMocks({
        server,
        service: {
            async disableVpnServer() {
                const error = new Error('Server has active assignments');
                error.code = 'SERVER_HAS_ACTIVE_ASSIGNMENTS';
                throw error;
            }
        }
    });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/notes`, { body: { body: 'x', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/notes`, { body: { body: 'maintenance', category: 'maintenance', reason: 'ops' } })).response.status, 200);

        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/flags`, { body: { flag: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/flags`, { body: { flag: 'overloaded', severity: 'critical' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/flags`, { body: { flag: 'manual_review', severity: 'high' } })).response.status, 200);
        assert.equal((await request('DELETE', `/api/admin/vpn-servers/${server._id}/flags/server-flag`, { body: { reason: 'resolved' } })).response.status, 200);

        const disableConflict = await request('POST', `/api/admin/vpn-servers/${server._id}/disable`, { body: { reason: 'maintenance' } });
        assert.equal(disableConflict.response.status, 409);

        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/reactivate`, { body: { reason: 'back' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/maintenance`, { body: { reason: 'planned' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/maintenance/clear`, { body: { reason: 'done' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/migrate-routers`, { body: { targetServerId: 'target-1', reason: 'balance' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/restart-vpn`, { body: { reason: 'repair' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/reconcile`, { body: { reason: 'sync' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/vpn-servers/${server._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
        assert.ok(ctx.auditCalls.length >= 7);
    });
});
