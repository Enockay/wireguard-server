const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouteTestContext, withRouteApp } = require('./helpers/test-kit');

const routeModulePath = 'routes/clients.js';

function createClientDoc(initial) {
    return {
        ...initial,
        toSafeJSON() {
            const safe = { ...this };
            delete safe.privateKey;
            return safe;
        },
        toObject() {
            return { ...this };
        },
        async save() {
            return this;
        }
    };
}

function createClientRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const state = {
        clients: (overrides.clients || [
            createClientDoc({
                _id: 'client-1',
                name: 'client-one',
                ip: '10.0.0.8/32',
                publicKey: 'pub-1',
                privateKey: 'priv-1',
                enabled: true,
                notes: 'Primary client',
                interfaceName: 'wg-client-one',
                endpoint: 'vpn.example.test:51820',
                allowedIPs: '0.0.0.0/0',
                dns: '8.8.8.8,1.1.1.1',
                persistentKeepalive: 25,
                transferRx: 0,
                transferTx: 0,
                lastHandshake: null,
                lastConnectionTime: null,
                lastConnectionIp: null,
                createdAt: '2026-04-01T00:00:00.000Z',
                updatedAt: '2026-04-01T00:00:00.000Z'
            }),
            createClientDoc({
                _id: 'client-2',
                name: 'client-two',
                ip: '10.0.0.9/32',
                publicKey: 'pub-2',
                privateKey: 'priv-2',
                enabled: true,
                notes: 'Secondary client',
                interfaceName: 'wg-client-two',
                endpoint: 'vpn.example.test:51820',
                allowedIPs: '0.0.0.0/0',
                dns: '1.1.1.1',
                persistentKeepalive: 25,
                transferRx: 0,
                transferTx: 0,
                lastHandshake: null,
                lastConnectionTime: null,
                lastConnectionIp: null,
                createdAt: '2026-04-02T00:00:00.000Z',
                updatedAt: '2026-04-02T00:00:00.000Z'
            })
        ]).map((client) => createClientDoc(client)),
        routers: overrides.routers || [],
        wgCommands: []
    };

    function findClientByName(name) {
        return state.clients.find((client) => client.name === String(name || '').toLowerCase()) || null;
    }

    const Client = {
        async countDocuments(query = {}) {
            if (query && typeof query.enabled === 'boolean') {
                return state.clients.filter((client) => client.enabled === query.enabled).length;
            }
            return state.clients.length;
        },
        find(query = {}) {
            const filtered = state.clients.filter((client) => {
                if (query.name && query.name.$in) {
                    return query.name.$in.includes(client.name);
                }
                if (query.enabled !== undefined && client.enabled !== query.enabled) {
                    return false;
                }
                if (query.$or) {
                    const search = String(query.$or[0]?.name?.$regex || '').toLowerCase();
                    const haystacks = [client.name, client.notes || '', client.ip || ''].map((value) => String(value).toLowerCase());
                    return haystacks.some((value) => value.includes(search));
                }
                return true;
            });

            return {
                then(resolve, reject) {
                    return Promise.resolve(filtered).then(resolve, reject);
                },
                sort(sortSpec = {}) {
                    const [[key, direction]] = Object.entries(sortSpec);
                    filtered.sort((left, right) => {
                        const leftValue = left[key] ?? '';
                        const rightValue = right[key] ?? '';
                        if (leftValue === rightValue) return 0;
                        return leftValue > rightValue ? direction : -direction;
                    });
                    return this;
                },
                skip(count = 0) {
                    this._skip = count;
                    return this;
                },
                async limit(limit = filtered.length) {
                    const start = this._skip || 0;
                    return filtered.slice(start, start + limit);
                }
            };
        },
        async findOne(query = {}) {
            if (query.name) {
                return findClientByName(query.name);
            }
            if (query.publicKey) {
                return state.clients.find((client) => client.publicKey === query.publicKey) || null;
            }
            return null;
        },
        async findById(id) {
            return state.clients.find((client) => String(client._id) === String(id)) || null;
        },
        async findOneAndUpdate(query, update) {
            const client = await this.findOne(query);
            if (!client) return null;
            Object.assign(client, update);
            client.updatedAt = '2026-04-09T00:00:00.000Z';
            return client;
        },
        async updateOne(query, update) {
            const client = query._id
                ? state.clients.find((entry) => String(entry._id) === String(query._id))
                : await this.findOne(query);
            if (!client) return { matchedCount: 0, modifiedCount: 0 };

            if (update.$set) {
                Object.assign(client, update.$set);
            } else {
                Object.assign(client, update);
            }
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(query) {
            const index = state.clients.findIndex((client) => client.name === String(query.name || '').toLowerCase());
            if (index >= 0) {
                state.clients.splice(index, 1);
            }
            return { deletedCount: index >= 0 ? 1 : 0 };
        },
        async deleteMany(query) {
            const names = query.name?.$in || [];
            const before = state.clients.length;
            state.clients = state.clients.filter((client) => !names.includes(client.name));
            return { deletedCount: before - state.clients.length };
        }
    };

    const MikrotikRouter = {
        find(query = {}) {
            const matchIds = query.wireguardClientId?.$in
                ? query.wireguardClientId.$in.map(String)
                : (query.wireguardClientId ? [String(query.wireguardClientId)] : []);
            const items = state.routers.filter((router) => {
                if (!matchIds.length) return true;
                return matchIds.includes(String(router.wireguardClientId));
            });

            return {
                select() {
                    return this;
                },
                async lean() {
                    return items.map((router) => ({ ...router }));
                }
            };
        }
    };

    return {
        ctx,
        state,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'models/Client.js': Client,
            'models/MikrotikRouter.js': MikrotikRouter,
            'wg-core.js': {
                wgLock: { run: async (fn) => fn() },
                log() {},
                KEEPALIVE_TIME: 25,
                validateKeepalive(value) {
                    return Number(value || 0) || 25;
                },
                runWgCommand: async (args) => {
                    state.wgCommands.push(args);
                    return '';
                },
                getServerPublicKey: async () => 'server-public-key',
                getServerEndpoint: () => 'vpn.example.test:51820'
            },
            'utils/route-helpers.js': {
                generateKeys: async () => ({ privateKey: 'generated-private', publicKey: 'generated-public' }),
                getNextAvailableIP: async () => '10.0.0.20/32',
                syncWireGuardPeerRoutesFromDatabase: async () => undefined,
                getTimeAgo: () => 'just now'
            }
        }
    };
}

test('client management routes now require admin authentication', async () => {
    const { mocks } = createClientRouteMocks();

    await withRouteApp({
        routeModulePath,
        mocks,
        routeArgs: [() => true]
    }, async ({ request }) => {
        const unauthenticated = await request('GET', '/api/clients', { token: null });
        assert.equal(unauthenticated.response.status, 401);
        assert.equal(unauthenticated.json.error, 'Authentication required');

        const forbidden = await request('GET', '/api/clients', { token: 'user' });
        assert.equal(forbidden.response.status, 403);
        assert.equal(forbidden.json.error, 'Admin access required');

        const adminAlias = await request('GET', '/api/admin/vpn-clients', { token: null });
        assert.equal(adminAlias.response.status, 401);
        assert.equal(adminAlias.json.error, 'Authentication required');
    });
});

test('updating allowed IPs and keepalive reapplies the live WireGuard peer config', async () => {
    const { mocks, state } = createClientRouteMocks();

    await withRouteApp({
        routeModulePath,
        mocks,
        routeArgs: [() => true]
    }, async ({ request }) => {
        const res = await request('PUT', '/api/admin/vpn-clients/client-one', {
            body: {
                allowedIPs: '10.9.0.0/24',
                persistentKeepalive: 55
            }
        });

        assert.equal(res.response.status, 200);
        assert.equal(res.json.success, true);
        assert.equal(state.wgCommands.length, 1);
        assert.deepEqual(state.wgCommands[0], ['set', 'wg0', 'peer', 'pub-1', 'allowed-ips', '10.0.0.8/32', 'persistent-keepalive', '55']);
    });
});

test('delete is blocked when the client is still referenced by a router', async () => {
    const { mocks } = createClientRouteMocks({
        routers: [
            {
                _id: 'router-1',
                name: 'Router One',
                status: 'active',
                vpnIp: '10.0.0.8/32',
                wireguardClientId: 'client-1'
            }
        ]
    });

    await withRouteApp({
        routeModulePath,
        mocks,
        routeArgs: [() => true]
    }, async ({ request }) => {
        const res = await request('DELETE', '/api/admin/vpn-clients/client-one');
        assert.equal(res.response.status, 409);
        assert.equal(res.json.error, 'CLIENT_LINKED_TO_ROUTER');
        assert.equal(res.json.linkedRouters.length, 1);
        assert.equal(res.json.linkedRouters[0].name, 'Router One');
    });
});

test('bulk delete is blocked when any selected client is linked to a router', async () => {
    const { mocks } = createClientRouteMocks({
        routers: [
            {
                _id: 'router-1',
                name: 'Router One',
                status: 'active',
                vpnIp: '10.0.0.8/32',
                wireguardClientId: 'client-1'
            }
        ]
    });

    await withRouteApp({
        routeModulePath,
        mocks,
        routeArgs: [() => true]
    }, async ({ request }) => {
        const res = await request('POST', '/api/admin/vpn-clients/bulk-delete', {
            body: {
                names: ['client-one', 'client-two']
            }
        });

        assert.equal(res.response.status, 409);
        assert.equal(res.json.error, 'CLIENT_LINKED_TO_ROUTER');
        assert.equal(res.json.blockedClients.length, 1);
        assert.equal(res.json.blockedClients[0].name, 'client-one');
    });
});

test('list and detail responses include linked router metadata for admin workflows', async () => {
    const { mocks } = createClientRouteMocks({
        routers: [
            {
                _id: 'router-1',
                name: 'Router One',
                status: 'active',
                vpnIp: '10.0.0.8/32',
                wireguardClientId: 'client-1'
            }
        ]
    });

    await withRouteApp({
        routeModulePath,
        mocks,
        routeArgs: [() => true]
    }, async ({ request }) => {
        const listRes = await request('GET', '/api/admin/vpn-clients');
        assert.equal(listRes.response.status, 200);
        const linkedClient = listRes.json.clients.find((client) => client.name === 'client-one');
        assert.equal(linkedClient.linkedRouterCount, 1);

        const detailRes = await request('GET', '/api/admin/vpn-clients/client-one?includePrivateKey=true');
        assert.equal(detailRes.response.status, 200);
        assert.equal(detailRes.json.data.linkedRouterCount, 1);
        assert.equal(detailRes.json.data.linkedRouters[0].name, 'Router One');
    });
});
