const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/network-config-service.js');

test('network config service accepts object-wrapped command results', async () => {
    const mocks = {
        'services/routeros-command-service.js': {
            async executeCommand(_routerId, command) {
                if (command === '/ip/dhcp-server/lease/print') {
                    return { data: [{ '.id': '*1', address: '192.168.88.10', 'mac-address': 'AA:BB:CC:DD:EE:FF' }] };
                }
                if (command === '/interface/wireless/registration-table/print') {
                    return { items: [{ 'mac-address': '11:22:33:44:55:66', interface: 'wlan1', signal: '-65' }] };
                }
                if (command === '/interface/print') {
                    return { records: [{ name: 'ether1', type: 'ether', mtu: '1500', running: 'true', disabled: 'false' }] };
                }
                return [];
            }
        }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { listDhcpLeases, listWirelessClients, listInterfaces } = require(serviceModulePath);

        const leases = await listDhcpLeases('router-1');
        const wireless = await listWirelessClients('router-1');
        const interfaces = await listInterfaces('router-1');

        assert.equal(leases.length, 1);
        assert.equal(leases[0].address, '192.168.88.10');
        assert.equal(wireless.length, 1);
        assert.equal(wireless[0].interface, 'wlan1');
        assert.equal(interfaces.length, 1);
        assert.equal(interfaces[0].name, 'ether1');

        delete require.cache[serviceModulePath];
    });
});
