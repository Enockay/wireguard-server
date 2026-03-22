const { executeCommand } = require('./routeros-command-service');

function parseDisabled(value) {
    return ['true', 'yes'].includes(String(value || '').toLowerCase());
}

function parseRunning(value) {
    return ['true', 'yes'].includes(String(value || '').toLowerCase());
}

function toNumber(value) {
    if (value == null || value === '') return 0;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
}

async function listDhcpLeases(routerId) {
    const records = await executeCommand(routerId, '/ip/dhcp-server/lease/print', {}, {
        operationName: 'get_system_resource',
        scope: 'interfaces'
    });

    return (records || []).map((record) => ({
        routerosId: record['.id'] || '',
        address: record.address || '',
        macAddress: record['mac-address'] || '',
        hostname: record.host-name || '',
        status: record.status || '',
        expiresAt: record.expires-after || record['expires-after'] || null,
        activeAddress: record['active-address'] || '',
        clientId: record['client-id'] || ''
    }));
}

async function makeStaticLease(routerId, routerosId) {
    await executeCommand(routerId, '/ip/dhcp-server/lease/make-static', { '.id': routerosId }, {
        operationName: 'interfaces_mutation',
        scope: 'interfaces'
    });
    return { message: 'Lease marked static' };
}

async function deleteLease(routerId, routerosId) {
    await executeCommand(routerId, '/ip/dhcp-server/lease/remove', { '.id': routerosId }, {
        operationName: 'interfaces_mutation',
        scope: 'interfaces'
    });
    return { message: 'Lease removed' };
}

async function listWirelessClients(routerId) {
    const records = await executeCommand(routerId, '/interface/wireless/registration-table/print', {}, {
        operationName: 'get_system_resource',
        scope: 'interfaces'
    });

    return (records || []).map((record) => ({
        macAddress: record['mac-address'] || '',
        interface: record.interface || '',
        signal: toNumber(record.signal || record['signal-strength']),
        txRate: record['tx-rate'] || '',
        rxRate: record['rx-rate'] || '',
        uptime: record.uptime || '',
        bytes: toNumber(record.bytes),
        packets: toNumber(record.packets)
    }));
}

async function listInterfaces(routerId) {
    const records = await executeCommand(routerId, '/interface/print', {}, {
        operationName: 'get_interfaces',
        scope: 'interfaces'
    });

    return (records || []).map((record) => ({
        name: record.name || '',
        type: record.type || '',
        mtu: toNumber(record.mtu),
        macAddress: record['mac-address'] || '',
        running: parseRunning(record.running),
        disabled: parseDisabled(record.disabled),
        rxBytes: toNumber(record['rx-byte']),
        txBytes: toNumber(record['tx-byte'])
    }));
}

async function setInterfaceEnabled(routerId, interfaceName, enabled) {
    await executeCommand(routerId, `/interface/${enabled ? 'enable' : 'disable'}`, { '.id': interfaceName }, {
        operationName: 'interfaces_mutation',
        scope: 'interfaces'
    });
    return { message: enabled ? 'Interface enabled' : 'Interface disabled' };
}

module.exports = {
    listDhcpLeases,
    makeStaticLease,
    deleteLease,
    listWirelessClients,
    listInterfaces,
    setInterfaceEnabled
};
