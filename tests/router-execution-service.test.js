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

test('management-only execution does not reject a router just because the admin label differs from RouterOS identity', async () => {
    const router = {
        _id: 'router-2',
        name: 'enockMikrotik',
        connectionMode: 'management_only',
        managementMode: 'management_only',
        status: 'active',
        endpointBinding: {
            expectedIdentity: null,
            state: 'unknown'
        },
        discoveryInfo: { localAddress: '192.168.88.1', openPorts: [8728] },
        managementEndpoints: [],
        capabilities: { interfacesRead: true, probedAt: new Date() },
        safetyPolicy: {
            defaultMaxClass: 'service_mutation',
            approvedScopes: ['interfaces'],
            allowNetworkCoreWrites: false
        }
    };

    const apiCalls = [];
    const mocks = {
        'models/MikrotikRouter.js': {
            findById(id) {
                if (id === 'router-2') return Promise.resolve(router);
                return Promise.resolve(null);
            },
            findByIdAndUpdate() {
                return Promise.resolve();
            }
        },
        'models/RouterConfigSnapshot.js': { create: async () => ({ _id: 'snapshot-2' }) },
        'utils/routeros-api-client.js': {
            async executeRouterOsApiCommand(payload) {
                apiCalls.push(payload.command);
                if (payload.command === '/interface/print') {
                    return { success: true, data: [{ name: 'ether1' }] };
                }
                if (payload.command === '/export') {
                    return { success: true, data: [{ '=output': '/export compact' }] };
                }
                if (payload.command === '/system/identity/print') {
                    return { success: true, data: [{ name: 'ChukaMikrotik' }] };
                }
                if (payload.command === '/system/routerboard/print') {
                    return { success: true, data: [{ 'serial-number': 'ABC123' }] };
                }
                return { success: true, data: [] };
            }
        },
        'services/mikrotik-api-service.js': {
            async executeRouterOSCommand() {
                throw new Error('ssh fallback should not run for API path');
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
                    definition: { commandClass: 'service_mutation', capability: 'interfacesRead', snapshot: true, scope: 'interfaces' },
                    details: {}
                };
            }
        },
        'services/operation-ledger-service.js': {
            async startOperation() {
                return { _id: 'operation-2' };
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

        const result = await execute('router-2', 'get_interfaces', {
            command: '/interface/print',
            scope: 'interfaces'
        });

        assert.deepEqual(result.data, [{ name: 'ether1' }]);
        assert.deepEqual(apiCalls, ['/export', '/interface/print']);

        delete require.cache[serviceModulePath];
    });
});

test('buildDefaultEndpoints keeps remote-managed routers on WireGuard paths only', async () => {
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
        const { buildDefaultEndpoints } = require(serviceModulePath);

        const router = {
            connectionMode: 'wireguard',
            status: 'active',
            vpnIp: '10.0.0.23/32',
            discoveryInfo: {
                localAddress: '192.168.100.8',
                openPorts: [8728]
            },
            managementEndpoints: [
                {
                    id: 'manual-primary',
                    kind: 'local_api',
                    host: '192.168.100.8',
                    port: 8728,
                    transport: 'api',
                    enabled: true,
                    priority: 1
                },
                {
                    id: 'manual-ssh',
                    kind: 'ssh_fallback',
                    host: '192.168.100.8',
                    port: 22,
                    transport: 'ssh',
                    enabled: true,
                    priority: 2
                }
            ]
        };

        const endpoints = buildDefaultEndpoints(router, { apiPort: 8728 });

        assert.deepEqual(
            endpoints.map((endpoint) => ({ kind: endpoint.kind, host: endpoint.host, transport: endpoint.transport })),
            [
                { kind: 'wireguard_management', host: '10.0.0.23', transport: 'api' },
                { kind: 'ssh_fallback', host: '10.0.0.23', transport: 'ssh' }
            ]
        );

        delete require.cache[serviceModulePath];
    });
});
