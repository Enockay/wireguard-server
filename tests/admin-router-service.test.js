const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/admin-router-service.js');

test('createRouterAdmin retries when a concurrent request takes the same VPN IP', async () => {
    const allocatedIps = ['10.0.0.6/32', '10.0.0.7/32'];
    const createdClients = [];
    let clientSaveAttempts = 0;

    class ClientMock {
        constructor(data) {
            Object.assign(this, data);
            this._id = `client-${createdClients.length + 1}`;
        }

        async save() {
            clientSaveAttempts += 1;
            if (clientSaveAttempts === 1) {
                const error = new Error('duplicate key error');
                error.code = 11000;
                error.keyPattern = { ip: 1 };
                error.keyValue = { ip: this.ip };
                throw error;
            }

            createdClients.push(this);
            return this;
        }

        static async findByIdAndDelete() {}
    }

    class RouterMock {
        constructor(data) {
            Object.assign(this, data);
            this._id = 'router-1';
        }

        async save() {
            return this;
        }

        static async findByIdAndDelete() {}

        static findOne() {
            return {
                async lean() {
                    return null;
                }
            };
        }
    }

    const mocks = {
        'models/MikrotikRouter.js': RouterMock,
        'models/User.js': {
            async findById(id) {
                return { _id: id, role: 'user' };
            }
        },
        'models/Client.js': ClientMock,
        'models/Subscription.js': {},
        'models/Transaction.js': {},
        'models/AdminAuditLog.js': {},
        'utils/port-allocator.js': {
            async allocatePorts() {
                return { winbox: 2201, ssh: 2202, api: 2203 };
            },
            async releasePorts() {}
        },
        'utils/route-helpers.js': {
            async generateKeys() {
                return { privateKey: 'private-key', publicKey: 'public-key' };
            },
            async getNextAvailableIP() {
                return allocatedIps.shift();
            }
        },
        'services/tcp-proxy-service.js': {
            async startRouterProxy() {},
            stopRouterProxy() {},
            async restartRouterProxy() {},
            getProxyStatus() { return null; }
        },
        'wg-core.js': {
            wgLock: { async run(fn) { return fn(); } },
            async runWgCommand() { return ''; },
            KEEPALIVE_TIME: 25,
            validateKeepalive(value) { return value; },
            getServerEndpoint() { return 'vpn.test.local:51820'; },
            async getServerPublicKey() { return 'server-public-key'; }
        },
        'services/billing-service.js': {
            async createSubscription() {}
        },
        'services/email-service.js': {
            async sendRouterDeletedEmail() {}
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { createRouterAdmin } = require(serviceModulePath);

        const result = await createRouterAdmin({
            userId: 'user-1',
            name: 'Branch Router'
        });

        assert.equal(result.client.ip, '10.0.0.7/32');
        assert.equal(result.router.vpnIp, '10.0.0.7/32');
        assert.equal(createdClients.length, 1);
        assert.equal(clientSaveAttempts, 2);

        delete require.cache[serviceModulePath];
    });
});

test('createRouterAdmin fails clearly after repeated VPN IP conflicts', async () => {
    class ClientMock {
        constructor(data) {
            Object.assign(this, data);
            this._id = 'client-conflict';
        }

        async save() {
            const error = new Error('duplicate key error');
            error.code = 11000;
            error.keyPattern = { ip: 1 };
            error.keyValue = { ip: this.ip };
            throw error;
        }

        static async findByIdAndDelete() {}
    }

    class RouterMock {
        constructor(data) {
            Object.assign(this, data);
            this._id = 'router-1';
        }

        async save() {
            return this;
        }

        static async findByIdAndDelete() {}

        static findOne() {
            return {
                async lean() {
                    return null;
                }
            };
        }
    }

    const mocks = {
        'models/MikrotikRouter.js': RouterMock,
        'models/User.js': {
            async findById(id) {
                return { _id: id, role: 'user' };
            }
        },
        'models/Client.js': ClientMock,
        'models/Subscription.js': {},
        'models/Transaction.js': {},
        'models/AdminAuditLog.js': {},
        'utils/port-allocator.js': {
            async allocatePorts() {
                return { winbox: 2201, ssh: 2202, api: 2203 };
            },
            async releasePorts() {}
        },
        'utils/route-helpers.js': {
            async generateKeys() {
                return { privateKey: 'private-key', publicKey: 'public-key' };
            },
            async getNextAvailableIP() {
                return '10.0.0.6/32';
            }
        },
        'services/tcp-proxy-service.js': {
            async startRouterProxy() {},
            stopRouterProxy() {},
            async restartRouterProxy() {},
            getProxyStatus() { return null; }
        },
        'wg-core.js': {
            wgLock: { async run(fn) { return fn(); } },
            async runWgCommand() { return ''; },
            KEEPALIVE_TIME: 25,
            validateKeepalive(value) { return value; },
            getServerEndpoint() { return 'vpn.test.local:51820'; },
            async getServerPublicKey() { return 'server-public-key'; }
        },
        'services/billing-service.js': {
            async createSubscription() {}
        },
        'services/email-service.js': {
            async sendRouterDeletedEmail() {}
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { createRouterAdmin } = require(serviceModulePath);

        await assert.rejects(
            () => createRouterAdmin({ userId: 'user-1', name: 'Branch Router' }),
            /Unable to allocate a unique VPN IP after multiple attempts/
        );

        delete require.cache[serviceModulePath];
    });
});
