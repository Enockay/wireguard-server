const MikrotikRouter = require('../models/MikrotikRouter');
const RouterMetric = require('../models/RouterMetric');
const { executeCommand, getSystemResource, getInterfaces } = require('./routeros-command-service');
const { getEndpointMismatchCooldownState } = require('./admin-router-service');
const { log } = require('../wg-core');

function toNumber(value) {
    if (value == null || value === '') return null;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? null : parsed;
}

function buildInterfaceMetrics(interfaces, previousMetric) {
    const previousInterfaces = new Map((previousMetric?.interfaces || []).map((item) => [item.name, item]));
    const previousTimestamp = previousMetric?.timestamp ? new Date(previousMetric.timestamp).getTime() : null;
    const now = Date.now();
    const elapsedSeconds = previousTimestamp ? Math.max(1, (now - previousTimestamp) / 1000) : null;

    return interfaces.map((item) => {
        const previous = previousInterfaces.get(item.name);
        const rxBps = elapsedSeconds && previous && item.rxBytes >= 0 ? Math.max(0, Math.round((item.rxBytes - (previous.rxBytesSnapshot || 0)) / elapsedSeconds)) : 0;
        const txBps = elapsedSeconds && previous && item.txBytes >= 0 ? Math.max(0, Math.round((item.txBytes - (previous.txBytesSnapshot || 0)) / elapsedSeconds)) : 0;

        return {
            name: item.name,
            rxBps,
            txBps,
            running: Boolean(item.running),
            rxBytesSnapshot: item.rxBytes || 0,
            txBytesSnapshot: item.txBytes || 0,
        };
    });
}

function normalizeWireGuardInterfaceRecord(record = {}) {
    return {
        name: record.name || null,
        running: ['true', 'yes'].includes(String(record.running || '').toLowerCase()),
        disabled: ['true', 'yes'].includes(String(record.disabled || '').toLowerCase())
    };
}

function parseHandshakeDate(value) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized === 'never') return null;

    const directDate = new Date(normalized);
    if (!Number.isNaN(directDate.getTime())) {
        return directDate;
    }

    const unixSeconds = Number(normalized);
    if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
        const unixDate = new Date(unixSeconds * 1000);
        if (!Number.isNaN(unixDate.getTime())) {
            return unixDate;
        }
    }

    return null;
}

function getWireGuardHandshakeState(lastHandshake) {
    if (!lastHandshake) return 'none';
    return (Date.now() - lastHandshake.getTime()) > 180000 ? 'stale' : 'fresh';
}

function normalizeWireGuardPeerRecord(record = {}) {
    const lastHandshake = parseHandshakeDate(record['last-handshake']);
    const parsedKeepalive = record['persistent-keepalive'] == null || record['persistent-keepalive'] === ''
        ? null
        : Number(record['persistent-keepalive']);
    return {
        publicKey: record['public-key'] || null,
        interface: record.interface || null,
        endpointAddress: record['endpoint-address'] || null,
        endpointPort: record['endpoint-port'] ? Number(record['endpoint-port']) : null,
        currentEndpointAddress: record['current-endpoint-address'] || null,
        currentEndpointPort: record['current-endpoint-port'] ? Number(record['current-endpoint-port']) : null,
        allowedAddress: record['allowed-address'] || null,
        persistentKeepalive: Number.isFinite(parsedKeepalive) ? parsedKeepalive : null,
        lastHandshake,
        handshakeState: getWireGuardHandshakeState(lastHandshake),
        rx: record.rx ? Number(record.rx) : 0,
        tx: record.tx ? Number(record.tx) : 0,
        disabled: ['true', 'yes'].includes(String(record.disabled || '').toLowerCase())
    };
}

async function getWireGuardTelemetry(routerId) {
    try {
        const [interfacesRecords, peersRecords] = await Promise.all([
            executeCommand(routerId, '/interface/wireguard/print', {}, { operationName: 'get_system_resource' }),
            executeCommand(routerId, '/interface/wireguard/peers/print', {}, { operationName: 'get_system_resource' })
        ]);

        const interfaces = Array.isArray(interfacesRecords) ? interfacesRecords.map(normalizeWireGuardInterfaceRecord) : [];
        const peers = Array.isArray(peersRecords) ? peersRecords.map(normalizeWireGuardPeerRecord) : [];
        const activePeerCount = peers.filter((peer) => peer.handshakeState === 'fresh').length;
        const stalePeerCount = peers.filter((peer) => peer.handshakeState === 'stale').length;
        const peersWithNoHandshake = peers.filter((peer) => peer.handshakeState === 'none').length;

        return {
            available: interfaces.length > 0 || peers.length > 0,
            interfaces,
            peers,
            summary: {
                available: interfaces.length > 0 || peers.length > 0,
                interfaceCount: interfaces.length,
                peerCount: peers.length,
                activePeerCount,
                stalePeerCount,
                peersWithNoHandshake,
                totalTransferRx: peers.reduce((sum, peer) => sum + (peer.rx || 0), 0),
                totalTransferTx: peers.reduce((sum, peer) => sum + (peer.tx || 0), 0)
            }
        };
    } catch (error) {
        return {
            available: false,
            interfaces: [],
            peers: [],
            summary: {
                available: false,
                interfaceCount: 0,
                peerCount: 0,
                activePeerCount: 0,
                stalePeerCount: 0,
                peersWithNoHandshake: 0,
                totalTransferRx: 0,
                totalTransferTx: 0
            },
            error: error.message
        };
    }
}

async function collectRouterTelemetry(routerId) {
    const [resource, interfaces, previousMetric, wireguardTelemetry] = await Promise.all([
        getSystemResource(routerId),
        getInterfaces(routerId),
        RouterMetric.findOne({ routerId }).sort({ timestamp: -1 }).lean(),
        getWireGuardTelemetry(routerId)
    ]);

    const cpuLoad = toNumber(resource.cpuLoad);
    const memTotalBytes = toNumber(resource.totalMemory);
    const memUsedBytes = toNumber(resource.memoryUsage != null ? resource.memoryUsage : (memTotalBytes != null && resource.freeMemory != null ? memTotalBytes - toNumber(resource.freeMemory) : null));
    const interfaceMetrics = buildInterfaceMetrics(interfaces, previousMetric);

    const metric = await RouterMetric.create({
        routerId,
        timestamp: new Date(),
        cpuLoad,
        memUsedBytes,
        memTotalBytes,
        uptime: resource.uptime || null,
        interfaces: interfaceMetrics.map((item) => ({
            name: item.name,
            rxBps: item.rxBps,
            txBps: item.txBps,
            running: item.running
        })),
        wireguardSummary: wireguardTelemetry.summary,
        wireguardPeers: (wireguardTelemetry.peers || []).map((peer) => ({
            publicKey: peer.publicKey,
            interface: peer.interface,
            endpointAddress: peer.endpointAddress,
            endpointPort: peer.endpointPort,
            currentEndpointAddress: peer.currentEndpointAddress,
            currentEndpointPort: peer.currentEndpointPort,
            allowedAddress: peer.allowedAddress,
            persistentKeepalive: peer.persistentKeepalive,
            lastHandshake: peer.lastHandshake,
            handshakeState: peer.handshakeState,
            rx: peer.rx,
            tx: peer.tx,
            disabled: peer.disabled
        })),
        collectionMethod: 'api'
    });

    await MikrotikRouter.findByIdAndUpdate(routerId, {
        routerosVersion: resource.version || null,
        'routerboardInfo.cpuLoad': cpuLoad,
        'routerboardInfo.memoryUsage': memUsedBytes,
        'routerboardInfo.totalMemory': memTotalBytes,
        'routerboardInfo.freeMemory': toNumber(resource.freeMemory),
        'routerboardInfo.uptime': resource.uptime || null,
        'routerboardInfo.boardName': resource.boardName || null,
        'routerboardInfo.model': resource.platform || null,
        'routerboardInfo.firmware': resource.version || null,
        'routerboardInfo.lastChecked': metric.timestamp
    }).catch(() => undefined);

    return metric;
}

async function runTelemetryPolling() {
    const routers = await MikrotikRouter.find({ status: 'active' }).select('_id endpointBinding failureState');
    const activeRouters = [];
    const skipped = [];

    for (const router of routers) {
        const cooldown = getEndpointMismatchCooldownState(router);
        if (cooldown.active) {
            skipped.push({
                routerId: String(router._id),
                success: false,
                skipped: true,
                reason: cooldown.reason,
                cooldownUntil: cooldown.until
            });
            log('info', 'router_telemetry_poll_skipped', {
                routerId: String(router._id),
                reason: 'endpoint_mismatch_cooldown',
                cooldownUntil: cooldown.until,
                remainingMs: cooldown.remainingMs
            });
            continue;
        }
        activeRouters.push(router);
    }

    const settled = await Promise.allSettled(activeRouters.map((router) => collectRouterTelemetry(router._id)));
    const succeeded = settled.filter((item) => item.status === 'fulfilled').length;
    const failed = settled.length - succeeded;

    log('info', 'router_telemetry_poll_completed', {
        polled: routers.length,
        attempted: activeRouters.length,
        succeeded,
        failed,
        skipped: skipped.length
    });

    return {
        polled: routers.length,
        attempted: activeRouters.length,
        succeeded,
        failed,
        skipped: skipped.length,
        results: settled.map((item, index) => ({
            routerId: String(activeRouters[index]._id),
            success: item.status === 'fulfilled',
            metric: item.status === 'fulfilled' ? item.value : null,
            error: item.status === 'rejected' ? (item.reason?.message || String(item.reason)) : null
        })).concat(skipped)
    };
}

async function getRouterMetricsHistory(routerId, windowHours = 24) {
    const hours = Math.max(1, Math.min(168, Number(windowHours) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return RouterMetric.find({
        routerId,
        timestamp: { $gte: since }
    }).sort({ timestamp: 1 }).lean();
}

module.exports = {
    collectRouterTelemetry,
    runTelemetryPolling,
    getRouterMetricsHistory
};
