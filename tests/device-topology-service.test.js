const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const mongoose = require('mongoose');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/device-topology-service.js');

test('topology service converts router ids to ObjectId for device and stats queries', async () => {
    const routerId = '69c2404892b7ad0f00a5a5cb';
    const captured = {
        deviceQuery: null,
        locationQuery: null,
        aggregatePipeline: null
    };

    const mocks = {
        'models/ConnectedDevice.js': {
            find(query) {
                if (query.$or) {
                    return {
                        select() {
                            return Promise.resolve([]);
                        }
                    };
                }
                captured.deviceQuery = query;
                return {
                    populate() {
                        return {
                            async sort() {
                                return [];
                            }
                        };
                    }
                };
            },
            findOne() {
                return {
                    lean() {
                        return Promise.resolve(null);
                    }
                };
            },
            async aggregate(pipeline) {
                captured.aggregatePipeline = pipeline;
                return [];
            },
            async bulkWrite() {
                return { modifiedCount: 0 };
            }
        },
        'models/RouterLocation.js': {
            async findOne(query) {
                captured.locationQuery = query;
                return null;
            }
        },
        'models/MikrotikRouter.js': {}
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const {
            getConnectedDevicesWithLocations,
            getConnectionStats
        } = require(serviceModulePath);

        const devicesResult = await getConnectedDevicesWithLocations(routerId);
        const statsResult = await getConnectionStats(routerId);

        assert.deepEqual(devicesResult, { parentLocation: null, devices: [] });
        assert.deepEqual(statsResult, {
            totalDevices: 0,
            onlineDevices: 0,
            offlineDevices: 0,
            avgLatency: 0,
            avgPacketLoss: 0,
            avgBandwidth: 0,
            accessPoints: 0,
            routers: 0,
            clients: 0
        });

        assert.ok(captured.deviceQuery.parentRouterId instanceof mongoose.Types.ObjectId);
        assert.equal(String(captured.deviceQuery.parentRouterId), routerId);
        assert.ok(captured.locationQuery.routerId instanceof mongoose.Types.ObjectId);
        assert.equal(String(captured.locationQuery.routerId), routerId);
        assert.ok(captured.aggregatePipeline[0].$match.parentRouterId instanceof mongoose.Types.ObjectId);
        assert.equal(String(captured.aggregatePipeline[0].$match.parentRouterId), routerId);

        delete require.cache[serviceModulePath];
    });
});

test('upsertConnectedDevice classifies phone-like clients separately from routers', async () => {
    const capturedUpdates = [];

    const mocks = {
        'models/ConnectedDevice.js': {
            findOne() {
                return {
                    lean() {
                        return Promise.resolve(null);
                    }
                };
            },
            async findOneAndUpdate(selector, update) {
                capturedUpdates.push({ selector, update });
                return { ...update, _id: `device-${capturedUpdates.length}`, identityKey: update.identityKey };
            },
            async updateMany() {
                return { acknowledged: true };
            }
        },
        'models/RouterLocation.js': {
            async findOne() {
                return null;
            }
        },
        'models/MikrotikRouter.js': {}
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { upsertConnectedDevice } = require(serviceModulePath);

        await upsertConnectedDevice('router-1', {
            deviceId: 'AA:BB:CC:DD:EE:01',
            ipAddress: '192.168.88.10',
            macAddress: 'AA:BB:CC:DD:EE:01',
            deviceName: 'Samsung Galaxy Phone',
            discoverySource: 'wireless'
        });

        await upsertConnectedDevice('router-1', {
            deviceId: '10.0.0.2',
            ipAddress: '10.0.0.2',
            deviceName: 'MikroTik Core Router',
            manufacturer: 'MikroTik',
            discoverySource: 'neighbor'
        });

        assert.equal(capturedUpdates[0].update.deviceType, 'client');
        assert.equal(capturedUpdates[1].update.deviceType, 'router');

        delete require.cache[serviceModulePath];
    });
});

test('getConnectedDevicesWithLocations reclassifies stored unknown arp devices to clients', async () => {
    const bulkWrites = [];

    const mocks = {
        'models/ConnectedDevice.js': {
            find(query) {
                if (query.$or) {
                    return {
                        select() {
                            return Promise.resolve([
                                {
                                    _id: 'device-1',
                                    deviceName: 'ARP 192.168.88.10',
                                    deviceType: 'unknown',
                                    discoverySource: 'arp',
                                    ipAddress: '192.168.88.10',
                                    macAddress: 'AA:BB:CC:DD:EE:01',
                                    manufacturer: null,
                                    model: null,
                                    interfaceName: 'bridge',
                                    notes: null,
                                    toObject() {
                                        return this;
                                    }
                                }
                            ]);
                        }
                    };
                }

                return {
                    populate() {
                        return {
                            async sort() {
                                return [];
                            }
                        };
                    }
                };
            },
            async bulkWrite(operations) {
                bulkWrites.push(...operations);
                return { modifiedCount: operations.length };
            },
            async aggregate() {
                return [];
            }
        },
        'models/RouterLocation.js': {
            async findOne() {
                return null;
            }
        },
        'models/MikrotikRouter.js': {}
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { getConnectedDevicesWithLocations } = require(serviceModulePath);

        await getConnectedDevicesWithLocations('69c2404892b7ad0f00a5a5cb');

        assert.equal(bulkWrites.length, 1);
        assert.equal(bulkWrites[0].updateOne.update.$set.deviceType, 'client');

        delete require.cache[serviceModulePath];
    });
});

test('upsertConnectedDevice does not downgrade a router classification when arp data arrives later', async () => {
    const updates = [];
    let existingRecord = {
        _id: 'device-router',
        deviceType: 'router',
        discoverySource: 'neighbor',
        manufacturer: 'MikroTik',
        model: 'hEX',
        interfaceName: 'ether1',
        latitude: null,
        longitude: null,
        location: null,
        publicKey: null,
        macAddress: 'aa:bb:cc:dd:ee:ff'
    };

    const mocks = {
        'models/ConnectedDevice.js': {
            findOne(query) {
                if (query.$or || query.identityKey || query.deviceId || query.macAddress || query.ipAddress) {
                    return {
                        lean() {
                            return Promise.resolve(existingRecord);
                        }
                    };
                }
                return {
                    lean() {
                        return Promise.resolve(null);
                    }
                };
            },
            async findOneAndUpdate(selector, update) {
                updates.push({ selector, update });
                existingRecord = { ...existingRecord, ...update };
                return existingRecord;
            },
            async updateMany() {
                return { acknowledged: true };
            },
            async bulkWrite() {
                return { modifiedCount: 0 };
            },
            find(query) {
                if (query.$or) {
                    return {
                        select() {
                            return Promise.resolve([]);
                        }
                    };
                }
                return {
                    populate() {
                        return {
                            async sort() {
                                return [];
                            }
                        };
                    }
                };
            },
            async aggregate() {
                return [];
            }
        },
        'models/RouterLocation.js': {
            async findOne() {
                return null;
            }
        },
        'models/MikrotikRouter.js': {}
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { upsertConnectedDevice } = require(serviceModulePath);

        await upsertConnectedDevice('router-1', {
            deviceId: 'AA:BB:CC:DD:EE:FF',
            ipAddress: '192.168.88.2',
            macAddress: 'AA:BB:CC:DD:EE:FF',
            deviceName: 'ARP 192.168.88.2',
            deviceType: 'client',
            discoverySource: 'arp'
        });

        assert.equal(updates[0].update.deviceType, 'router');
        assert.equal(updates[0].update.discoverySource, 'neighbor');

        delete require.cache[serviceModulePath];
    });
});
