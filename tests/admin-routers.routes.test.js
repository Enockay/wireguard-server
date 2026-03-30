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
    const targetUser = overrides.targetUser || { _id: '507f1f77bcf86cd799439099', name: 'Customer One', email: 'customer@example.com', role: 'user' };
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
        async getLatestDownstreamDiscoveryRun() { return { id: 'discovery-1', parentRouterId: router._id, discoveredRouterCount: 1, discoveredRouters: [{ ipAddress: '10.0.5.2', confidence: 'high' }] }; },
        async discoverDownstreamMikrotiks() { return { id: 'discovery-1', parentRouterId: router._id, discoveredRouterCount: 1, candidateSubnetCount: 2, probedTargetCount: 3, discoveredRouters: [{ ipAddress: '10.0.5.2', confidence: 'high' }] }; },
        async createRouterAdmin() {
            return { router, owner: targetUser, artifacts: { wireguardConfig: '[Interface]' } };
        },
        async createManagementOnlyRouterAdmin() {
            return { router, owner: targetUser, artifacts: null };
        },
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
            if (id !== router._id) {
                return {
                    async populate() {
                        return null;
                    }
                };
            }
            router.populate = async () => router;
            return router;
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
            'services/routeros-command-service.js': {
                async getSystemResource() {
                    return { cpuLoad: 12, version: '7.16.1', boardName: 'RB5009' };
                },
                async getInterfaces() {
                    return [{ name: 'ether1', type: 'ethernet', running: true, disabled: false, rxBytes: 10, txBytes: 20 }];
                },
                async pingTest() {
                    return { sent: 4, received: 4, packetLoss: 0, avgRtt: 2 };
                },
                async rebootRouter() {
                    return { message: 'Reboot command sent' };
                },
                resolveRouterManagementHost() {
                    return '10.0.0.10';
                },
                async executeCommand() {
                    return [];
                }
            },
            'services/router-credential-service.js': {
                async rotateCredential() {
                    return { _id: 'cred-1' };
                },
                async markCredentialVerified() {
                    return true;
                }
            },
            'services/router-execution-service.js': {
                async execute(routerId, operationName, context) {
                    if (operationName === 'raw_command' && String(context.command || '').includes('set') && !context.breakGlass) {
                        const error = new Error('unsafe_operation_blocked');
                        error.failureType = 'unsafe_operation_blocked';
                        throw error;
                    }
                    return { data: [{ ok: true }] };
                }
            },
            'services/capability-probe-service.js': {
                async probeCapabilities() {
                    return {
                        systemRead: true,
                        identityRead: true,
                        interfacesRead: true
                    };
                }
            },
            'services/downstream-mikrotik-discovery-service.js': {
                async getLatestDownstreamDiscoveryRun(routerId) {
                    return service.getLatestDownstreamDiscoveryRun(routerId);
                },
                async discoverDownstreamMikrotiks(routerId, options, actorContext) {
                    return service.discoverDownstreamMikrotiks(routerId, options, actorContext);
                }
            },
            'models/MikrotikRouter.js': routerModel,
            'models/User.js': {
                async findOne(query) {
                    if (query.email && query.email === targetUser.email) return targetUser;
                    if (query._id && query._id === targetUser._id) return targetUser;
                    return null;
                }
            }
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
            `/api/admin/routers/${router._id}/downstream-mikrotiks`,
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
            async getLatestDownstreamDiscoveryRun() { return null; },
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
            '/api/admin/routers/missing/downstream-mikrotiks',
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

        const downstream = await request('POST', `/api/admin/routers/${router._id}/downstream-mikrotiks/discover`, { body: { reason: 'topology check', dryRun: true } });
        assert.equal(downstream.response.status, 200);

        const deleted = await request('DELETE', `/api/admin/routers/${router._id}`, { body: { reason: 'cleanup' } });
        assert.equal(deleted.response.status, 200);
        assert.ok(ctx.auditCalls.some((call) => call.action === 'admin.routers.delete'));
    });
});

test('admin router api credential and connection routes update router state and return telemetry', async () => {
    const router = createDoc({
        _id: '507f1f77bcf86cd799439061',
        name: 'RTR-API',
        serverNode: 'wireguard',
        apiUsername: 'admin',
        apiPassword: '',
        apiPort: 8728,
        userId: { _id: '507f1f77bcf86cd799439099' },
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });

    const { mocks, ctx } = createRouterRouteMocks({ router });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const invalidPort = await request('POST', `/api/admin/routers/${router._id}/set-credentials`, { body: { apiPort: 70000 } });
        assert.equal(invalidPort.response.status, 400);

        const saved = await request('POST', `/api/admin/routers/${router._id}/set-credentials`, {
            body: { apiUsername: 'ops-admin', apiPassword: 'secret', apiPort: 8729, reason: 'bootstrap api access' }
        });
        assert.equal(saved.response.status, 200);
        assert.equal(router.apiUsername, 'ops-admin');
        assert.equal(router.apiPassword, 'secret');
        assert.equal(router.apiPort, 8729);
        assert.equal(router.credentialState.secretRef, 'cred-1');
        assert.equal(saved.json.data.credentialState.secretConfigured, true);

        const tested = await request('POST', `/api/admin/routers/${router._id}/test-connection`, { body: { reason: 'verify live API' } });
        assert.equal(tested.response.status, 200);
        assert.equal(tested.json.data.resource.version, '7.16.1');
        assert.equal(tested.json.data.interfaces.length, 1);
        assert.equal(tested.json.data.capabilities.systemRead, true);
        assert.equal(tested.json.data.credentialState.secretConfigured, true);
        assert.ok(ctx.auditCalls.some((call) => call.action === 'admin.routers.set_credentials'));
        assert.ok(ctx.auditCalls.some((call) => call.action === 'admin.routers.test_connection'));
    });
});

test('admin router create route supports customer email, management-only setup, and connection testing', async () => {
    const router = createDoc({
        _id: '507f1f77bcf86cd799439081',
        name: 'RTR-MGMT',
        connectionMode: 'management_only',
        managementMode: 'management_only',
        status: 'active',
        apiUsername: 'admin',
        apiPassword: '',
        apiPort: 8728,
        managementEndpoints: [],
        discoveryInfo: {},
        credentialState: {},
        capabilities: {},
        ports: {},
        safetyPolicy: {
            defaultMaxClass: 'service_mutation',
            allowNetworkCoreWrites: false,
            approvedScopes: ['queues']
        },
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });
    const { mocks, ctx } = createRouterRouteMocks({ router });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const created = await request('POST', '/api/admin/routers', {
            body: {
                customerEmail: 'customer@example.com',
                name: 'RTR-MGMT',
                connectionMode: 'management_only',
                managementHost: '192.168.88.1',
                hostname: 'branch-core',
                apiUsername: 'ops-admin',
                apiPassword: 'secret',
                apiPort: 8728,
                deviceDetails: 'Installed in the server room with direct API access.',
                testConnectionOnCreate: true,
                reason: 'manual onboarding'
            }
        });

        assert.equal(created.response.status, 201);
        assert.equal(created.json.data.customer.email, 'customer@example.com');
        assert.equal(created.json.data.connectionMode, 'management_only');
        assert.equal(created.json.data.connectionTest.success, true);
        assert.equal(router.apiUsername, 'ops-admin');
        assert.equal(router.apiPassword, 'secret');
        assert.equal(router.apiPort, 8728);
        assert.equal(router.managementEndpoints[0].host, '192.168.88.1');
        assert.equal(router.discoveryInfo.localAddress, '192.168.88.1');
        assert.equal(router.credentialState.secretRef, 'cred-1');
        assert.equal(router.credentialState.state, 'active');
        assert.equal(router.safetyPolicy.defaultMaxClass, 'service_mutation');
        assert.deepEqual(router.safetyPolicy.approvedScopes, ['queues']);
        assert.equal(router.safetyPolicy.allowNetworkCoreWrites, false);
        assert.ok(router.adminNotes.some((entry) => entry.body.includes('Manual router onboarding details')));
        assert.ok(ctx.auditCalls.some((call) => call.action === 'admin_create_router'));
    });
});

test('admin router raw command route blocks unsafe commands without break-glass', async () => {
    const router = createDoc({
        _id: '507f1f77bcf86cd799439071',
        name: 'RTR-CMD',
        serverNode: 'wireguard',
        status: 'active',
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });
    const { mocks } = createRouterRouteMocks({ router });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        const blocked = await request('POST', `/api/admin/routers/${router._id}/command`, {
            body: { command: '/queue simple set 0 disabled=yes', reason: 'test' }
        });
        assert.equal(blocked.response.status, 403);

        const allowed = await request('POST', `/api/admin/routers/${router._id}/command`, {
            body: { command: '/queue simple set 0 disabled=yes', reason: 'test', breakGlass: true }
        });
        assert.equal(allowed.response.status, 200);
    });
});
