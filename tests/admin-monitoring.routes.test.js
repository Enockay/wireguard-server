const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDoc,
    createPermissionProxy,
    createRouteTestContext,
    withRouteApp
} = require('./helpers/test-kit');

const routeModulePath = 'routes/admin-monitoring.js';

function createMonitoringRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const incident = overrides.incident || createDoc({ _id: '507f1f77bcf86cd799439081', title: 'Router offline' });

    const service = {
        ADMIN_MONITORING_PERMISSIONS: createPermissionProxy(),
        INCIDENT_NOTE_CATEGORIES: ['incident', 'review'],
        async getMonitoringOverview() { return { routers: 1 }; },
        async getMonitoringTrends() { return { buckets: [] }; },
        async getMonitoringActivity() { return { items: [{ id: 'a1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getMonitoringDiagnostics() { return { items: [], summary: {} }; },
        async getRouterHealthSummary() { return { total: 1 }; },
        async listUnhealthyRouters() { return { items: [{ id: 'r1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listOfflineRouters() { return { items: [{ id: 'r1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listProvisioningIssueRouters() { return { items: [{ id: 'r1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listStaleRouters() { return { items: [{ id: 'r1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getVpnServerHealthSummary() { return { total: 1 }; },
        async listUnhealthyVpnServers() { return { items: [{ id: 's1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listOverloadedVpnServers() { return { items: [{ id: 's1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listStaleVpnServers() { return { items: [{ id: 's1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getPeerHealthSummary() { return { total: 1 }; },
        async listStalePeers() { return { items: [{ id: 'p1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listUnhealthyPeers() { return { items: [{ id: 'p1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getTrafficSummary() { return { totalBytes: 100 }; },
        async getTrafficTrends() { return { buckets: [] }; },
        async getTopTrafficRouters() { return { items: [{ id: 'r1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getTopTrafficServers() { return { items: [{ id: 's1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getCustomerImpactSummary() { return { affectedUsers: 0 }; },
        async listAffectedCustomers() { return { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } }; },
        async getProvisioningSummary() { return { pending: 0 }; },
        async getProvisioningTrends() { return { buckets: [] }; },
        async listProvisioningFailures() { return { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } }; },
        async listMonitoringIncidents() { return { items: [incident], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getMonitoringIncidentDetail() { return incident; },
        async getMonitoringIncidentDocument() { return incident; },
        async getMonitoringIncidentNotes() { return [{ body: 'check' }]; },
        async acknowledgeMonitoringIncident() { return incident; },
        async resolveMonitoringIncident() { return incident; },
        async markMonitoringIncidentReviewed() { return incident; },
        async addMonitoringIncidentNote() { return { body: 'added' }; },
        ...overrides.service
    };

    const incidentModel = {
        async findById(id) { return id === incident._id ? incident : null; },
        ...overrides.model
    };

    return {
        ctx,
        incident,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/admin-monitoring-service.js': service,
            'models/MonitoringIncident.js': incidentModel
        }
    };
}

test('admin monitoring routes enforce auth and return read payloads', async () => {
    const { mocks, incident } = createMonitoringRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('GET', '/api/admin/monitoring/overview', { token: null })).response.status, 401);
        for (const path of [
            '/api/admin/monitoring/overview',
            '/api/admin/monitoring/trends',
            '/api/admin/monitoring/activity',
            '/api/admin/monitoring/diagnostics',
            '/api/admin/monitoring/routers/summary',
            '/api/admin/monitoring/routers/unhealthy',
            '/api/admin/monitoring/routers/offline',
            '/api/admin/monitoring/routers/provisioning-issues',
            '/api/admin/monitoring/routers/stale',
            '/api/admin/monitoring/vpn-servers/summary',
            '/api/admin/monitoring/vpn-servers/unhealthy',
            '/api/admin/monitoring/vpn-servers/overloaded',
            '/api/admin/monitoring/vpn-servers/stale',
            '/api/admin/monitoring/peers/summary',
            '/api/admin/monitoring/peers/stale',
            '/api/admin/monitoring/peers/unhealthy',
            '/api/admin/monitoring/traffic/summary',
            '/api/admin/monitoring/traffic/trends',
            '/api/admin/monitoring/traffic/top-routers',
            '/api/admin/monitoring/traffic/top-servers',
            '/api/admin/monitoring/customers/impact',
            '/api/admin/monitoring/customers/affected',
            '/api/admin/monitoring/provisioning/summary',
            '/api/admin/monitoring/provisioning/trends',
            '/api/admin/monitoring/provisioning/failures',
            '/api/admin/monitoring/incidents',
            `/api/admin/monitoring/incidents/${incident._id}`,
            `/api/admin/monitoring/incidents/${incident._id}/notes`
        ]) {
            assert.equal((await request('GET', path)).response.status, 200, path);
        }
    });
});

test('admin monitoring incident actions validate note payloads and create audits', async () => {
    const { mocks, ctx, incident } = createMonitoringRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/acknowledge`, { body: { reason: 'triage' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/resolve`, { body: { reason: 'fixed' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/notes`, { body: { body: 'x', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/monitoring/incidents/${incident._id}/notes`, { body: { body: 'investigating', category: 'review', reason: 'ops' } })).response.status, 200);
        assert.ok(ctx.auditCalls.length >= 4);
    });
});
