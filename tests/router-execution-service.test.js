const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/router-execution-service.js');

test('classifyFailure treats no-route errors as endpoint_unreachable instead of auth_failed', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterConfigSnapshot.js': {},
        'utils/routeros-api-client.js': {},
        'services/mikrotik-api-service.js': {},
        'services/router-credential-service.js': {},
        'services/operation-policy-service.js': {},
        'services/operation-ledger-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { classifyFailure } = require(serviceModulePath);

        const failureType = classifyFailure(new Error(
            'Command failed: ssh -o PasswordAuthentication=yes admin@10.0.0.11 "/system/resource/print"\nssh: connect to host 10.0.0.11 port 22: No route to host'
        ));

        assert.equal(failureType, 'endpoint_unreachable');

        delete require.cache[serviceModulePath];
    });
});

test('classifyFailure treats ssh permission denied as auth_failed even when command contains ConnectTimeout option', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterConfigSnapshot.js': {},
        'utils/routeros-api-client.js': {},
        'services/mikrotik-api-service.js': {},
        'services/router-credential-service.js': {},
        'services/operation-policy-service.js': {},
        'services/operation-ledger-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { classifyFailure } = require(serviceModulePath);

        const failureType = classifyFailure(new Error(
            'Command failed: ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no -o BatchMode=yes admin@167.86.73.169 "/interface/print"\nadmin@167.86.73.169: Permission denied (publickey,password).'
        ));

        assert.equal(failureType, 'auth_failed');

        delete require.cache[serviceModulePath];
    });
});

test('classifyFailure treats RouterOS invalid time value as transport_error instead of timeout', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterConfigSnapshot.js': {},
        'utils/routeros-api-client.js': {},
        'services/mikrotik-api-service.js': {},
        'services/router-credential-service.js': {},
        'services/operation-policy-service.js': {},
        'services/operation-ledger-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { classifyFailure } = require(serviceModulePath);

        const failureType = classifyFailure(new Error('invalid time value for argument session-timeout'));

        assert.equal(failureType, 'transport_error');

        delete require.cache[serviceModulePath];
    });
});

test('execute does not use ssh fallback for structured commands with attributes', async () => {
    const router = {
        _id: 'router-1',
        connectionMode: 'management_only',
        managementMode: 'management_only',
        status: 'active',
        discoveryInfo: { localAddress: '192.168.88.1', openPorts: [8728] },
        managementEndpoints: [],
        capabilities: { queueWrite: true, probedAt: new Date() },
        safetyPolicy: {
            defaultMaxClass: 'service_mutation',
            approvedScopes: ['queues'],
            allowNetworkCoreWrites: false
        }
    };

    const mocks = {
        'models/MikrotikRouter.js': {
            findById(id) {
                if (id === 'router-1') return Promise.resolve(router);
                return Promise.resolve(null);
            },
            findByIdAndUpdate() {
                return Promise.resolve();
            }
        },
        'models/RouterConfigSnapshot.js': { create: async () => ({ _id: 'snapshot-1' }) },
        'utils/routeros-api-client.js': {
            async executeRouterOsApiCommand() {
                return { success: false, error: 'failure: can\'t edit dynamic object' };
            }
        },
        'services/mikrotik-api-service.js': {
            async executeRouterOSCommand() {
                throw new Error('ssh fallback should not run for structured commands');
            }
        },
        'services/router-credential-service.js': {
            async getResolvedCredential() {
                return { username: 'admin', password: 'secret', apiPort: 8728 };
            }
        },
        'services/operation-policy-service.js': {
            authorizeOperation() {
                return {
                    allowed: true,
                    reason: null,
                    definition: { commandClass: 'service_mutation', capability: 'queueWrite', snapshot: true, scope: 'queues' },
                    details: {}
                };
            }
        },
        'services/operation-ledger-service.js': {
            async startOperation() {
                return { _id: 'operation-1' };
            },
            async finalizeOperation() {
                return true;
            }
        },
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { execute } = require(serviceModulePath);

        await assert.rejects(
            () => execute('router-1', 'queue_mutation', {
                command: '/queue/simple/set',
                attributes: { '.id': '*1', 'max-limit': '1024k/2048k' },
                scope: 'queues'
            }),
            (error) => {
                assert.equal(error.failureType, 'transport_error');
                assert.equal(error.message, 'transport_error');
                return true;
            }
        );

        delete require.cache[serviceModulePath];
    });
});
