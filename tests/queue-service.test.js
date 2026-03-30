const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/queue-service.js');

test('updateQueue blocks edits to dynamic queues', async () => {
    const dynamicQueue = {
        _id: 'queue-1',
        routerId: 'router-1',
        routerosId: '*1',
        name: 'hotspot-dynamic',
        target: '192.168.88.10/32',
        maxDownloadKbps: 10000,
        maxUploadKbps: 10000,
        queueType: 'pcq',
        pcqDownloadProfile: 'default-small',
        pcqUploadProfile: 'default-small',
        isDynamic: true
    };

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            findOne(query) {
                if (query.routerId === 'router-1' && query.routerosId === '*1') return Promise.resolve(dynamicQueue);
                return Promise.resolve(null);
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand() {
                throw new Error('should not execute router command for dynamic queue');
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { updateQueue } = require(serviceModulePath);

        await assert.rejects(
            () => updateQueue('router-1', '*1', { maxDownloadKbps: 2048 }),
            /Dynamic queues cannot be edited directly/i
        );

        delete require.cache[serviceModulePath];
    });
});

test('createQueue places hotspot overrides before conflicting dynamic queues', async () => {
    const executed = [];
    let printCount = 0;

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            async create(payload) {
                return {
                    _id: 'queue-1',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    isActive: true,
                    ...payload
                };
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand(routerId, command, attributes) {
                executed.push({ routerId, command, attributes });
                if (command === '/queue/simple/print') {
                    printCount += 1;
                    if (printCount === 1) {
                        return [
                            { '.id': '*5', name: 'hotspot-254758108929', target: '192.168.88.120/32', dynamic: 'true', queue: 'default-small/default-small' }
                        ];
                    }
                    return [
                        { '.id': '*5', name: 'hotspot-254758108929', target: '192.168.88.120/32', dynamic: 'true', queue: 'default-small/default-small' },
                        { '.id': '*6', name: 'override-hotspot-254758108929', target: '192.168.88.120/32', dynamic: 'false' }
                    ];
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { createQueue } = require(serviceModulePath);

        const created = await createQueue('router-1', {
            name: 'override-hotspot-254758108929',
            target: '192.168.88.120/32',
            maxDownloadKbps: 2048,
            maxUploadKbps: 1024,
            comment: 'override'
        });

        const addCall = executed.find((entry) => entry.command === '/queue/simple/add');
        assert.ok(addCall, 'expected add queue command to execute');
        assert.equal(addCall.attributes['place-before'], '*5');
        assert.equal(created.routerosId, '*6');

        delete require.cache[serviceModulePath];
    });
});

test('createQueue reuses an existing static queue with the same name instead of failing', async () => {
    const staticQueue = {
        _id: 'queue-1',
        routerId: 'router-1',
        routerosId: '*9',
        name: 'override-hotspot-user1-192-168-88-120-32',
        target: '192.168.88.120/32',
        maxDownloadKbps: 1000,
        maxUploadKbps: 1000,
        comment: 'override',
        queueType: 'simple',
        isDynamic: false
    };
    const executed = [];

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            findOne(query) {
                if (query.routerId === 'router-1' && query.routerosId === '*9') return Promise.resolve(staticQueue);
                return Promise.resolve(null);
            },
            findOneAndUpdate(query, update) {
                return Promise.resolve({
                    ...staticQueue,
                    ...update.$set
                });
            },
            async create() {
                throw new Error('should not create duplicate queue document');
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand(routerId, command, attributes) {
                executed.push({ routerId, command, attributes });
                if (command === '/queue/simple/print') {
                    return [
                        { '.id': '*9', name: 'override-hotspot-user1-192-168-88-120-32', target: '192.168.88.120/32', dynamic: 'false', 'max-limit': '2000k/3000k' }
                    ];
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { createQueue } = require(serviceModulePath);

        const result = await createQueue('router-1', {
            name: 'override-hotspot-user1-192-168-88-120-32',
            target: '192.168.88.120/32',
            maxDownloadKbps: 3000,
            maxUploadKbps: 2000,
            comment: 'override'
        });

        assert.equal(result.routerosId, '*9');
        assert.ok(executed.some((entry) => entry.command === '/queue/simple/set'));
        assert.ok(!executed.some((entry) => entry.command === '/queue/simple/add'));

        delete require.cache[serviceModulePath];
    });
});

test('updateQueue repositions static overrides ahead of conflicting dynamic queues', async () => {
    const executed = [];
    const staticQueue = {
        _id: 'queue-1',
        routerId: 'router-1',
        routerosId: '*9',
        name: 'hotspot-override-254758108929',
        target: '192.168.88.120/32',
        maxDownloadKbps: 1000,
        maxUploadKbps: 1000,
        comment: 'override',
        queueType: 'simple',
        isDynamic: false
    };

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            findOne(query) {
                if (query.routerId === 'router-1' && query.routerosId === '*9') return Promise.resolve(staticQueue);
                return Promise.resolve(null);
            },
            findOneAndUpdate(query, update) {
                return Promise.resolve({
                    ...staticQueue,
                    ...update.$set
                });
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand(routerId, command, attributes) {
                executed.push({ routerId, command, attributes });
                if (command === '/queue/simple/print') {
                    return [
                        { '.id': '*5', name: 'hotspot-254758108929', target: '192.168.88.120/32', dynamic: 'true', queue: 'default-small/default-small' },
                        { '.id': '*9', name: 'hotspot-override-254758108929', target: '192.168.88.120/32', dynamic: 'false', 'max-limit': '1000k/2000k' }
                    ];
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { updateQueue } = require(serviceModulePath);

        await updateQueue('router-1', '*9', { maxDownloadKbps: 2000, maxUploadKbps: 1000 });

        const moveCall = executed.find((entry) => entry.command === '/queue/simple/move');
        assert.ok(moveCall, 'expected queue move command to execute');
        assert.equal(moveCall.attributes.numbers, '*9');
        assert.equal(moveCall.attributes.destination, '*5');

        delete require.cache[serviceModulePath];
    });
});

test('listQueues syncs RouterOS queues by routerosId instead of conflating same-target dynamic and static queues', async () => {
    const bulkOps = [];
    const updates = [];
    let countQuery = null;
    let findQuery = null;

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            async bulkWrite(operations) {
                bulkOps.push(...operations);
            },
            async updateMany(filter, update) {
                updates.push({ filter, update });
            },
            find(query) {
                findQuery = query;
                if (query?.routerosId?.$in) {
                    return {
                        sort() {
                            return Promise.resolve([]);
                        }
                    };
                }
                return {
                    sort() {
                        return {
                            skip() {
                                return {
                                    limit() {
                                        return Promise.resolve([]);
                                    }
                                };
                            }
                        };
                    }
                };
            },
            async countDocuments(query) {
                countQuery = query;
                return 0;
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand(routerId, command) {
                if (command === '/queue/simple/print') {
                    return [
                        { '.id': '*5', name: 'hotspot-dynamic', target: '192.168.88.120/32', dynamic: 'true', queue: 'default-small/default-small', 'max-limit': '10000000/10000000' },
                        { '.id': '*6', name: 'hotspot-override', target: '192.168.88.120/32', dynamic: 'false', 'max-limit': '2000k/3000k' }
                    ];
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { listQueues } = require(serviceModulePath);

        await listQueues('router-1', 1, 50);

        assert.equal(bulkOps.length, 2);
        assert.deepEqual(countQuery, { routerId: 'router-1', isActive: true });
        assert.deepEqual(findQuery, { routerId: 'router-1', isActive: true });
        assert.equal(bulkOps[0].updateOne.update.$set.maxUploadKbps, 10000);
        assert.equal(bulkOps[0].updateOne.update.$set.maxDownloadKbps, 10000);
        assert.deepEqual(
            bulkOps.map((operation) => operation.updateOne.filter),
            [
                { routerId: 'router-1', routerosId: '*5' },
                { routerId: 'router-1', routerosId: '*6' }
            ]
        );

        delete require.cache[serviceModulePath];
    });
});

test('updateQueue verification accepts RouterOS raw bit-per-second max-limit output', async () => {
    const staticQueue = {
        _id: 'queue-1',
        routerId: 'router-1',
        routerosId: '*9',
        name: 'override-hotspot-user1',
        target: '192.168.88.120/32',
        maxDownloadKbps: 10000,
        maxUploadKbps: 10000,
        comment: 'override',
        queueType: 'simple',
        isDynamic: false
    };

    const mocks = {
        'models/MikrotikRouter.js': {
            findById() {
                return { select() { return Promise.resolve({ _id: 'router-1', vpnIp: '10.0.0.1' }); } };
            }
        },
        'models/RouterQueue.js': {
            findOne(query) {
                if (query.routerId === 'router-1' && query.routerosId === '*9') return Promise.resolve(staticQueue);
                return Promise.resolve(null);
            },
            findOneAndUpdate(query, update) {
                return Promise.resolve({
                    ...staticQueue,
                    ...update.$set
                });
            }
        },
        'models/ServicePlan.js': {},
        'models/Subscription.js': {},
        'services/routeros-command-service.js': {
            async executeCommand(routerId, command) {
                if (command === '/queue/simple/print') {
                    return [
                        { '.id': '*9', name: 'override-hotspot-user1', target: '192.168.88.120/32', dynamic: 'false', 'max-limit': '10000000/10000000' }
                    ];
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { updateQueue } = require(serviceModulePath);

        const updated = await updateQueue('router-1', '*9', { maxDownloadKbps: 10000, maxUploadKbps: 10000 });
        assert.equal(updated.maxDownloadKbps, 10000);
        assert.equal(updated.maxUploadKbps, 10000);

        delete require.cache[serviceModulePath];
    });
});
