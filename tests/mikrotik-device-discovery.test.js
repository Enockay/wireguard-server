const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/mikrotik-device-discovery.js');

function loadService() {
    delete require.cache[serviceModulePath];
    return require(serviceModulePath);
}

test('discoverArpDevices executes topology discovery commands with the expected context', async () => {
    const executeCalls = [];
    const upserts = [];
    const offlineSweeps = [];

    const mocks = {
        'services/device-topology-service.js': {
            async upsertConnectedDevice(routerId, device) {
                upserts.push({ routerId, device });
                return { ...device, identityKey: `mac:${device.macAddress.toLowerCase()}` };
            },
            async markMissingDevicesOffline(routerId, source, activeIdentityKeys) {
                offlineSweeps.push({ routerId, source, activeIdentityKeys });
            }
        },
        'services/router-execution-service.js': {
            async execute(routerId, operationName, context, actorContext) {
                executeCalls.push({ routerId, operationName, context, actorContext });
                return {
                    records: [
                        {
                            address: '10.0.0.2',
                            'mac-address': 'AA:BB:CC:DD:EE:FF',
                            interface: 'bridge1',
                            disabled: 'false'
                        }
                    ]
                };
            }
        }
    };

    await withMockedModules(mocks, async () => {
        const { discoverArpDevices } = loadService();
        const result = await discoverArpDevices('router-1', { actor: 'admin@test.local' });

        assert.equal(result.status, 'completed');
        assert.equal(result.count, 1);
        assert.equal(executeCalls.length, 1);
        assert.equal(executeCalls[0].operationName, 'topology_discovery');
        assert.equal(executeCalls[0].context.command, '/ip/arp/print');
        assert.deepEqual(executeCalls[0].context.attributes, {});
        assert.equal(upserts[0].device.discoverySource, 'arp');
        assert.equal(offlineSweeps[0].source, 'arp');
        assert.deepEqual(offlineSweeps[0].activeIdentityKeys, ['mac:aa:bb:cc:dd:ee:ff']);
    });
});

test('discoverWirelessDevices falls back to wifi registration tables when legacy wireless is unavailable', async () => {
    const executeCalls = [];

    const mocks = {
        'services/device-topology-service.js': {
            async upsertConnectedDevice(routerId, device) {
                return { ...device, identityKey: `mac:${device.macAddress.toLowerCase()}` };
            },
            async markMissingDevicesOffline() {}
        },
        'services/router-execution-service.js': {
            async execute(routerId, operationName, context) {
                executeCalls.push({ routerId, operationName, context });
                if (context.command === '/interface/wireless/registration-table/print') {
                    const error = new Error('no such command');
                    error.failureType = 'capability_missing';
                    throw error;
                }

                return {
                    records: [
                        {
                            'mac-address': '11:22:33:44:55:66',
                            'host-name': 'wifi-client',
                            'last-ip': '192.168.88.10',
                            interface: 'wifi1',
                            signal: '-55'
                        }
                    ]
                };
            }
        }
    };

    await withMockedModules(mocks, async () => {
        const { discoverWirelessDevices } = loadService();
        const result = await discoverWirelessDevices('router-1', { actor: 'admin@test.local' });

        assert.equal(result.status, 'completed');
        assert.equal(result.command, '/interface/wifi/registration-table/print');
        assert.equal(result.attempts.length, 1);
        assert.equal(executeCalls.length, 2);
        assert.equal(executeCalls[0].context.command, '/interface/wireless/registration-table/print');
        assert.equal(executeCalls[1].context.command, '/interface/wifi/registration-table/print');
    });
});

test('runFullDeviceDiscovery reports partial results instead of claiming complete success when probes fail', async () => {
    const offlineSweeps = [];

    const mocks = {
        'services/device-topology-service.js': {
            async upsertConnectedDevice(routerId, device) {
                return { ...device, identityKey: `ip:${device.ipAddress}` };
            },
            async markMissingDevicesOffline(routerId, source, activeIdentityKeys) {
                offlineSweeps.push({ routerId, source, activeIdentityKeys });
            }
        },
        'services/router-execution-service.js': {
            async execute(routerId, operationName, context) {
                if (context.command === '/ip/arp/print') {
                    return {
                        records: [
                            {
                                address: '10.0.0.9',
                                'mac-address': 'AA:AA:AA:AA:AA:AA',
                                interface: 'bridge1'
                            }
                        ]
                    };
                }

                throw new Error(`unsupported:${context.command}`);
            }
        }
    };

    await withMockedModules(mocks, async () => {
        const { runFullDeviceDiscovery } = loadService();
        const result = await runFullDeviceDiscovery('router-1', { actor: 'admin@test.local' });

        assert.equal(result.status, 'partial');
        assert.equal(result.discoveries.arp, 1);
        assert.ok(result.failedSources >= 1);
        assert.ok(result.errors.some((item) => item.source === 'wireless'));
        assert.ok(offlineSweeps.some((item) => item.source === 'arp'));
    });
});

test('discoverLldpNeighbors persists discovered neighbors as routers', async () => {
    const upserts = [];

    const mocks = {
        'services/device-topology-service.js': {
            async upsertConnectedDevice(routerId, device) {
                upserts.push({ routerId, device });
                return { ...device, identityKey: `device:${device.deviceId}` };
            },
            async markMissingDevicesOffline() {}
        },
        'services/router-execution-service.js': {
            async execute(routerId, operationName, context) {
                return {
                    records: [
                        {
                            identity: 'MikroTik-Branch',
                            address: '192.168.100.2',
                            interface: 'ether1',
                            platform: 'MikroTik',
                            version: '7.18'
                        }
                    ]
                };
            }
        }
    };

    await withMockedModules(mocks, async () => {
        const { discoverLldpNeighbors } = loadService();
        const result = await discoverLldpNeighbors('router-1', { actor: 'admin@test.local' });

        assert.equal(result.status, 'completed');
        assert.equal(result.count, 1);
        assert.equal(upserts[0].device.deviceType, 'router');
    });
});

test('discoverWireGuardPeers ignores invalid handshake timestamps instead of failing the whole probe', async () => {
    const upserts = [];

    const mocks = {
        'services/device-topology-service.js': {
            async upsertConnectedDevice(routerId, device) {
                upserts.push({ routerId, device });
                return { ...device, identityKey: `publicKey:${device.publicKey}` };
            },
            async markMissingDevicesOffline() {}
        },
        'services/router-execution-service.js': {
            async execute(routerId, operationName, context) {
                if (context.command === '/interface/wireguard/peers/print') {
                    return {
                        records: [
                            {
                                'public-key': 'abc123xyz',
                                comment: 'WG peer',
                                'allowed-address': '10.10.10.2/32',
                                'last-handshake': '3m12s',
                                tx: '1024',
                                rx: '2048'
                            }
                        ]
                    };
                }

                return { records: [] };
            }
        }
    };

    await withMockedModules(mocks, async () => {
        const { discoverWireGuardPeers } = loadService();
        const result = await discoverWireGuardPeers('router-1', { actor: 'admin@test.local' });

        assert.equal(result.status, 'completed');
        assert.equal(result.count, 1);
        assert.equal(upserts[0].device.lastConnected, null);
        assert.equal(upserts[0].device.isOnline, false);
    });
});
