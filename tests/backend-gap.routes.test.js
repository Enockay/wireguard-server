const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createPermissionProxy,
    createRouteTestContext,
    withMockedModules,
    withRouteApp
} = require('./helpers/test-kit');

function createRouteCollector() {
    const routes = [];
    const app = {};

    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        app[method] = (routePath, ...handlers) => {
            routes.push({ method: method.toUpperCase(), routePath, handlers });
        };
    }

    return { app, routes };
}

function matchRoute(pattern, actualPath) {
    const patternParts = pattern.split('/').filter(Boolean);
    const actualParts = actualPath.split('/').filter(Boolean);

    if (patternParts.length !== actualParts.length) {
        return null;
    }

    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const expected = patternParts[index];
        const received = actualParts[index];

        if (expected.startsWith(':')) {
            params[expected.slice(1)] = received;
            continue;
        }

        if (expected !== received) {
            return null;
        }
    }

    return params;
}

async function invokeRoute(routes, method, rawPath, { token = 'admin', body, headers = {} } = {}) {
    const url = new URL(`http://test.local${rawPath}`);
    const pathname = url.pathname;
    const route = routes.find((entry) => entry.method === method && matchRoute(entry.routePath, pathname));

    if (!route) {
        throw new Error(`No route registered for ${method} ${pathname}`);
    }

    const req = {
        method,
        url: rawPath,
        path: pathname,
        originalUrl: rawPath,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers
        },
        body,
        params: matchRoute(route.routePath, pathname),
        query: Object.fromEntries(url.searchParams.entries()),
        get(name) {
            return this.headers[String(name).toLowerCase()];
        }
    };

    const res = {
        statusCode: 200,
        headers: {},
        payload: undefined,
        finished: false,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        json(payload) {
            this.payload = payload;
            this.finished = true;
            return this;
        },
        send(payload) {
            this.payload = payload;
            this.finished = true;
            return this;
        }
    };

    async function runHandler(index) {
        if (index >= route.handlers.length || res.finished) return;

        const handler = route.handlers[index];
        let nextCalled = false;

        await new Promise((resolve, reject) => {
            const next = (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                nextCalled = true;
                resolve();
            };

            Promise.resolve(handler(req, res, next))
                .then(() => {
                    if (!nextCalled || handler.length < 3) resolve();
                })
                .catch(reject);
        });

        if (nextCalled) {
            await runHandler(index + 1);
        }
    }

    await runHandler(0);
    return { response: { status: res.statusCode }, json: res.payload, headers: res.headers };
}

test('backup routes expose single backup detail metadata', async () => {
    const ctx = createRouteTestContext();
    const backup = {
        _id: 'backup-1',
        routerId: 'router-1',
        filename: 'router-backup.rsc',
        exportText: '/export compact',
        createdBy: 'admin@test.local',
        note: 'before change',
        triggeredBy: 'manual',
        createdAt: '2026-03-20T00:00:00.000Z'
    };

    await withRouteApp({
        routeModulePath: 'routes/backup.js',
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-router-service.js': { ADMIN_ROUTER_PERMISSIONS: createPermissionProxy() },
            'services/backup-service.js': {
                async listBackups() { return { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } }; },
                async createBackup() { return backup; },
                async getBackupContent() { return backup; },
                async deleteBackup() { return true; }
            },
            'models/RouterBackup.js': {
                findOne(query) {
                    return {
                        lean: async () => (query._id === 'backup-1' ? backup : null)
                    };
                }
            }
        }
    }, async ({ request }) => {
        const unauthorized = await request('GET', '/api/admin/routers/router-1/backups/backup-1', { token: null });
        assert.equal(unauthorized.response.status, 401);

        const result = await request('GET', '/api/admin/routers/router-1/backups/backup-1');
        assert.equal(result.response.status, 200);
        assert.equal(result.json.backup.id, 'backup-1');
        assert.equal(result.json.backup.filename, 'router-backup.rsc');
        assert.equal(result.json.backup.exportText, undefined);
    });
});

test('pppoe profile routes support update and delete', async () => {
    const ctx = createRouteTestContext();
    let updatedPayload = null;
    let deletedProfileId = null;

    await withRouteApp({
        routeModulePath: 'routes/pppoe.js',
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-router-service.js': { ADMIN_ROUTER_PERMISSIONS: createPermissionProxy() },
            'services/pppoe-service.js': {
                async listPppoeSecrets() { return { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } }; },
                async createPppoeSecret() { return {}; },
                async updatePppoeSecret() { return {}; },
                async deletePppoeSecret() { return {}; },
                async listActiveSessions() { return []; },
                async disconnectSession() { return {}; },
                async listProfiles() { return []; },
                async createProfile() { return {}; },
                async updateProfile(_routerId, profileId, payload) {
                    updatedPayload = { profileId, payload };
                    return { id: profileId, ...payload };
                },
                async deleteProfile(_routerId, profileId) {
                    deletedProfileId = profileId;
                    return { message: 'PPPoE profile deleted' };
                }
            },
            'models/PppoeSecret.js': {}
        }
    }, async ({ request }) => {
        const updateResult = await request('PUT', '/api/admin/routers/router-1/pppoe/profiles/profile-1', {
            body: { name: 'Office', rateLimit: '20M/10M' }
        });
        assert.equal(updateResult.response.status, 200);
        assert.deepEqual(updatedPayload, { profileId: 'profile-1', payload: { name: 'Office', rateLimit: '20M/10M' } });

        const deleteResult = await request('DELETE', '/api/admin/routers/router-1/pppoe/profiles/profile-1');
        assert.equal(deleteResult.response.status, 200);
        assert.equal(deletedProfileId, 'profile-1');
    });
});

test('firewall nat routes support update', async () => {
    const ctx = createRouteTestContext();
    let updateCall = null;

    await withRouteApp({
        routeModulePath: 'routes/firewall.js',
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-router-service.js': { ADMIN_ROUTER_PERMISSIONS: createPermissionProxy() },
            'services/firewall-service.js': {
                async listFilterRules() { return []; },
                async addFilterRule() { return {}; },
                async updateFilterRule() { return {}; },
                async deleteFilterRule() { return {}; },
                async toggleFilterRule() { return {}; },
                async listNatRules() { return []; },
                async addNatRule() { return {}; },
                async updateNatRule(routerId, ruleId, payload) {
                    updateCall = { routerId, ruleId, payload };
                    return { id: ruleId, ...payload };
                },
                async deleteNatRule() { return {}; },
                async listAddressLists() { return []; },
                async addToAddressList() { return {}; },
                async removeFromAddressList() { return {}; },
                async blockSubscriber() { return {}; },
                async unblockSubscriber() { return {}; }
            }
        }
    }, async ({ request }) => {
        const result = await request('PUT', '/api/admin/routers/router-1/firewall/nat/*1', {
            body: { chain: 'dstnat', action: 'dst-nat', toPorts: '22' }
        });
        assert.equal(result.response.status, 200);
        assert.deepEqual(updateCall, {
            routerId: 'router-1',
            ruleId: '*1',
            payload: { chain: 'dstnat', action: 'dst-nat', toPorts: '22' }
        });
    });
});

test('hotspot voucher routes list and revoke vouchers', async () => {
    const ctx = createRouteTestContext();
    let revokedVoucherId = null;

    await withRouteApp({
        routeModulePath: 'routes/hotspot.js',
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-router-service.js': { ADMIN_ROUTER_PERMISSIONS: createPermissionProxy() },
            'services/hotspot-service.js': {
                async listHotspotUsers() { return { items: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } }; },
                async getHotspotUserDetail() { return {}; },
                async createHotspotUser() { return {}; },
                async updateHotspotUser() { return {}; },
                async deleteHotspotUser() { return {}; },
                async listActiveSessions() { return []; },
                async disconnectSession() { return {}; },
                async generateVouchers() { return []; },
                async listProfiles() { return []; },
                async listVouchers() {
                    return {
                        items: [{ id: 'voucher-1', username: 'HS-1', status: 'unused' }],
                        pagination: { page: 1, limit: 50, total: 1, pages: 1 }
                    };
                },
                async revokeVoucher(_routerId, voucherId) {
                    revokedVoucherId = voucherId;
                    return { message: 'Voucher revoked' };
                }
            }
        }
    }, async ({ request }) => {
        const listResult = await request('GET', '/api/admin/routers/router-1/hotspot/vouchers?status=unused');
        assert.equal(listResult.response.status, 200);
        assert.equal(listResult.json.vouchers[0].id, 'voucher-1');

        const deleteResult = await request('DELETE', '/api/admin/routers/router-1/hotspot/vouchers/voucher-1');
        assert.equal(deleteResult.response.status, 200);
        assert.equal(revokedVoucherId, 'voucher-1');
    });
});

test('admin management exposes reseller stub route', async () => {
    const ctx = createRouteTestContext();

    await withRouteApp({
        routeModulePath: 'routes/admin-management.js',
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'models/User.js': {
                async find() { return []; }
            }
        }
    }, async ({ request }) => {
        const result = await request('GET', '/api/admin/resellers');
        assert.equal(result.response.status, 501);
        assert.equal(result.json.error, 'Not implemented');
    });
});
