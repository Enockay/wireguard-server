const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClientPeerAllowedIps, getAdditionalServerPeerRoutes } = require('../utils/wireguard-peer-routes');

test('buildClientPeerAllowedIps includes tunnel IP and linked management endpoints', () => {
    const client = {
        ip: '10.0.0.8/32'
    };

    const routes = buildClientPeerAllowedIps(client, [
        {
            discoveryInfo: {
                localAddress: '192.168.100.8'
            },
            managementEndpoints: [
                { host: '192.168.100.8' },
                { host: 'router.example.com' }
            ],
            remoteBootstrap: {
                preferredManagementSubnet: '192.168.100.0/24'
            }
        }
    ]);

    assert.equal(routes, '10.0.0.8/32,192.168.100.0/24,192.168.100.8/32');
});

test('getAdditionalServerPeerRoutes excludes the tunnel /32 and keeps routed management targets', () => {
    const routes = getAdditionalServerPeerRoutes(
        { ip: '10.0.0.8/32' },
        [{ discoveryInfo: { localAddress: '192.168.100.8' } }]
    );

    assert.deepEqual(routes, ['192.168.100.8/32']);
});
