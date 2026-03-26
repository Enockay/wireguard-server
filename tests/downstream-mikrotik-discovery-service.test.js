const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/downstream-mikrotik-discovery-service.js');

function loadService() {
    delete require.cache[serviceModulePath];
    return require(serviceModulePath);
}

test('generateCandidateSubnets keeps private infrastructure ranges and respects exclusions', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { generateCandidateSubnets, normalizeOptions } = loadService();
        const result = generateCandidateSubnets({
            addressRecords: [{ address: '192.168.10.1/24' }],
            routeRecords: [
                { 'dst-address': '10.20.30.0/24', gateway: '192.168.10.254', active: 'true' },
                { 'dst-address': '8.8.8.0/24', gateway: '192.168.10.2', active: 'true' }
            ],
            dhcpNetworks: [{ address: '172.16.50.0/24' }],
            options: normalizeOptions({ excludeCidrs: ['172.16.50.0/24'] })
        });

        assert.deepEqual(
            result.subnets.map((item) => item.cidr),
            ['192.168.10.0/24', '10.20.30.0/24']
        );
        assert.ok(result.warnings.some((item) => item.includes('172.16.50.0/24')));
    });
});

test('generateProbeTargets enforces maxProbeTargets and excludes parent addresses', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { generateProbeTargets, normalizeOptions } = loadService();
        const result = generateProbeTargets({
            candidateSubnets: [
                { cidr: '192.168.88.0/24', priority: 10, reason: 'lan' },
                { cidr: '10.0.5.0/29', priority: 5, reason: 'routed' }
            ],
            routeRecords: [{ gateway: '192.168.88.1', 'dst-address': '10.0.5.0/29' }],
            arpRecords: [{ address: '192.168.88.2' }],
            neighborRecords: [{ address: '192.168.88.3' }],
            parentIps: ['192.168.88.1'],
            options: normalizeOptions({ maxProbeTargets: 4 })
        });

        assert.equal(result.targets.length, 4);
        assert.ok(result.targets.every((item) => item.ipAddress !== '192.168.88.1'));
        assert.ok(result.warnings.some((item) => item.includes('truncated')));
    });
});

test('generateProbeTargets prioritizes route gateways and router-like addresses before generic probes', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { generateProbeTargets, normalizeOptions } = loadService();
        const result = generateProbeTargets({
            candidateSubnets: [
                { cidr: '10.0.0.0/24', priority: 10, reason: 'lan' },
                { cidr: '10.0.0.12/32', priority: 5, reason: 'host-route' }
            ],
            routeRecords: [
                { gateway: '192.168.100.1', 'dst-address': '0.0.0.0/0' },
                { gateway: '10.0.0.254', 'dst-address': '10.10.20.0/24' }
            ],
            arpRecords: [{ address: '10.0.0.77' }, { address: '10.0.0.1' }, { address: '10.0.0.200' }],
            neighborRecords: [{ address: '10.0.0.88' }],
            parentIps: ['10.0.0.10'],
            options: normalizeOptions({ maxProbeTargets: 5 })
        });

        assert.equal(result.targets[0].ipAddress, '10.0.0.254');
        assert.ok(!result.targets.some((item) => item.ipAddress === '192.168.100.1'));
        assert.ok(result.targets.some((item) => item.ipAddress === '10.0.0.12'));
        assert.ok(result.targets.some((item) => item.ipAddress === '10.0.0.1'));
    });
});

test('generateProbeTargets respects allowed subnet targeting', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { generateProbeTargets, normalizeOptions } = loadService();
        const result = generateProbeTargets({
            candidateSubnets: [
                { cidr: '10.0.0.0/24', priority: 10, reason: 'lan' },
                { cidr: '192.168.88.0/24', priority: 20, reason: 'mgmt' }
            ],
            routeRecords: [{ gateway: '10.0.0.254', 'dst-address': '10.0.0.0/24' }, { gateway: '192.168.88.1', 'dst-address': '192.168.88.0/24' }],
            arpRecords: [{ address: '10.0.0.1' }, { address: '192.168.88.2' }],
            neighborRecords: [{ address: '10.0.0.2' }, { address: '192.168.88.3' }],
            parentIps: [],
            options: normalizeOptions({ maxProbeTargets: 10, allowedSubnetCidrs: ['10.0.0.0/24'] })
        });

        assert.ok(result.targets.every((item) => item.ipAddress.startsWith('10.0.0.')));
    });
});

test('generateProbeTargets caps weak ARP fan-out per subnet', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { generateProbeTargets, normalizeOptions } = loadService();
        const arpRecords = Array.from({ length: 20 }, (_, index) => ({ address: `192.168.100.${index + 10}` }));
        const result = generateProbeTargets({
            candidateSubnets: [{ cidr: '192.168.100.0/24', priority: 10, reason: 'lan' }],
            routeRecords: [],
            arpRecords,
            neighborRecords: [],
            parentIps: [],
            options: normalizeOptions({ maxProbeTargets: 50, allowedSubnetCidrs: ['192.168.100.0/24'] })
        });

        const arpTargets = result.targets.filter((item) => item.sourceMethod.includes('arp_table'));
        assert.ok(arpTargets.length <= 2);
    });
});

test('mergeDiscoveredRouters deduplicates by IP and preserves highest confidence', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { mergeDiscoveredRouters } = loadService();
        const merged = mergeDiscoveredRouters([
            {
                ipAddress: '10.0.0.2',
                confidence: 'low',
                evidence: ['winbox'],
                sourceMethod: ['targeted_probe'],
                reachable: true
            },
            {
                ipAddress: '10.0.0.2',
                confidence: 'high',
                evidence: ['neighbor'],
                sourceMethod: ['neighbor_discovery'],
                reachable: true,
                identity: 'downstream-core'
            }
        ]);

        assert.equal(merged.length, 1);
        assert.equal(merged[0].confidence, 'high');
        assert.equal(merged[0].identity, 'downstream-core');
        assert.deepEqual(merged[0].sourceMethod.sort(), ['neighbor_discovery', 'targeted_probe']);
    });
});

test('classifyCandidateFingerprint grades MikroTik evidence conservatively', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterLease.js': {},
        'models/DownstreamRouterDiscoveryRun.js': {},
        'services/router-execution-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        const { classifyCandidateFingerprint } = loadService();

        const high = classifyCandidateFingerprint({ sshBanner: 'SSH-2.0-RouterOS_7.15', apiReachable: true, winboxReachable: true, neighborHint: false });
        assert.equal(high.confidence, 'high');

        const medium = classifyCandidateFingerprint({ sshBanner: null, apiReachable: true, winboxReachable: true, neighborHint: false });
        assert.equal(medium.confidence, 'medium');

        const low = classifyCandidateFingerprint({ sshBanner: null, apiReachable: false, winboxReachable: true, neighborHint: false });
        assert.equal(low.confidence, 'low');
    });
});
