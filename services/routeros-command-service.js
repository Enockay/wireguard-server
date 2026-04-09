const MikrotikRouter = require('../models/MikrotikRouter');
const { execute } = require('./router-execution-service');

function stripCidrSuffix(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    return normalized.split('/')[0].trim();
}

function resolveRouterManagementHost(router) {
    const endpoints = Array.isArray(router?.managementEndpoints) ? router.managementEndpoints : [];
    const prefersRemoteManagement = router?.connectionMode !== 'management_only' && router?.status === 'active';
    const healthRank = { healthy: 0, degraded: 1, unknown: 2, stale: 3, unreachable: 4 };
    const vpnHost = stripCidrSuffix(router?.vpnIp);
    const localHost = stripCidrSuffix(router?.discoveryInfo?.localAddress);

    if (prefersRemoteManagement) {
        return vpnHost || '';
    }

    const preferred = [...endpoints]
        .filter((endpoint) => endpoint.enabled !== false && endpoint.health !== 'unreachable')
        .sort((a, b) => {
            const aRemote = prefersRemoteManagement && ['wireguard_api', 'public_api_tls'].includes(a?.kind);
            const bRemote = prefersRemoteManagement && ['wireguard_api', 'public_api_tls'].includes(b?.kind);
            if (aRemote !== bRemote) {
                return aRemote ? -1 : 1;
            }
            const healthDiff = (healthRank[a?.health] ?? 9) - (healthRank[b?.health] ?? 9);
            if (healthDiff !== 0) return healthDiff;
            return (a?.priority || 999) - (b?.priority || 999);
        })[0];
    if (preferred?.host) return preferred.host;

    if (router?.status !== 'active' && localHost) {
        return localHost;
    }

    return vpnHost || localHost || '';
}

function toNumber(value) {
    if (value == null || value === '') return null;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? null : parsed;
}

function parseResourceRecord(record = {}) {
    const totalMemory = toNumber(record['total-memory']);
    const freeMemory = toNumber(record['free-memory']);
    return {
        cpuLoad: toNumber(record['cpu-load']),
        freeMemory,
        totalMemory,
        uptime: record.uptime || null,
        boardName: record['board-name'] || null,
        version: record.version || null,
        platform: record.platform || null,
        architectureName: record['architecture-name'] || null,
        freeHddSpace: toNumber(record['free-hdd-space']),
        totalHddSpace: toNumber(record['total-hdd-space']),
        memoryUsage: totalMemory != null && freeMemory != null ? totalMemory - freeMemory : null
    };
}

async function executeCommand(routerId, command, attributes = {}, options = {}) {
    const operationName = options.operationName || 'get_system_resource';
    const result = await execute(routerId, operationName, {
        command,
        attributes,
        timeout: options.timeout || 5000,
        metadata: options.metadata || null,
        breakGlass: Boolean(options.breakGlass),
        dryRun: Boolean(options.dryRun),
        scope: options.scope || null
    }, {
        actor: options.actor || 'system',
        actorType: options.actorType || 'system',
        requestId: options.requestId || null
    });

    return Array.isArray(result.records) ? result.records : result.data;
}

async function getSystemResource(routerId, options = {}) {
    const records = await executeCommand(routerId, '/system/resource/print', {}, { ...options, operationName: 'get_system_resource' });
    const resource = parseResourceRecord(records[0] || {});

    await MikrotikRouter.findByIdAndUpdate(routerId, {
        routerosVersion: resource.version || null,
        'routerboardInfo.boardName': resource.boardName || null,
        'routerboardInfo.model': resource.platform || null,
        'routerboardInfo.firmware': resource.version || null,
        'routerboardInfo.uptime': resource.uptime || null,
        'routerboardInfo.cpuLoad': resource.cpuLoad,
        'routerboardInfo.totalMemory': resource.totalMemory,
        'routerboardInfo.freeMemory': resource.freeMemory,
        'routerboardInfo.memoryUsage': resource.memoryUsage,
        'routerboardInfo.lastChecked': new Date()
    }).catch(() => undefined);

    return resource;
}

async function getInterfaces(routerId, options = {}) {
    const records = await executeCommand(routerId, '/interface/print', {}, { ...options, operationName: 'get_interfaces' });
    return records.map((record) => ({
        name: record.name || 'unknown',
        type: record.type || 'unknown',
        running: ['true', 'yes'].includes(String(record.running || '').toLowerCase()),
        disabled: ['true', 'yes'].includes(String(record.disabled || '').toLowerCase()),
        rxBytes: toNumber(record['rx-byte']) || 0,
        txBytes: toNumber(record['tx-byte']) || 0
    }));
}

async function rebootRouter(routerId, options = {}) {
    await executeCommand(routerId, '/system/reboot', {}, { ...options, operationName: 'reboot' });
    return { message: 'Reboot command sent' };
}

async function pingTest(routerId, address, count = 4, options = {}) {
    const records = await executeCommand(routerId, '/ping', { address, count: String(count) }, { ...options, operationName: 'ping' });
    const times = records
        .map((record) => toNumber(record.time))
        .filter((value) => value != null);
    const sent = Number(count) || 4;
    const received = records.length;
    const avgRtt = times.length ? Number((times.reduce((sum, value) => sum + value, 0) / times.length).toFixed(2)) : null;

    return {
        sent,
        received,
        packetLoss: sent > 0 ? Number((((sent - received) / sent) * 100).toFixed(2)) : 0,
        avgRtt
    };
}

async function getRouterLogs(routerId, limit = 50, options = {}) {
    const records = await executeCommand(routerId, '/log/print', { '.proplist': 'time,topics,message' }, { ...options, operationName: 'get_logs' });
    return records.slice(-Math.max(1, limit)).map((record) => ({
        time: record.time || null,
        topics: record.topics || '',
        message: record.message || ''
    }));
}

module.exports = {
    stripCidrSuffix,
    resolveRouterManagementHost,
    executeCommand,
    getSystemResource,
    getInterfaces,
    rebootRouter,
    pingTest,
    getRouterLogs
};
