const MikrotikRouter = require('../models/MikrotikRouter');
const RouterMetric = require('../models/RouterMetric');
const { getSystemResource, getInterfaces } = require('./routeros-command-service');
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

async function collectRouterTelemetry(routerId) {
    const [resource, interfaces, previousMetric] = await Promise.all([
        getSystemResource(routerId),
        getInterfaces(routerId),
        RouterMetric.findOne({ routerId }).sort({ timestamp: -1 }).lean()
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
    const routers = await MikrotikRouter.find({ status: 'active' }).select('_id');
    const settled = await Promise.allSettled(routers.map((router) => collectRouterTelemetry(router._id)));
    const succeeded = settled.filter((item) => item.status === 'fulfilled').length;
    const failed = settled.length - succeeded;

    log('info', 'router_telemetry_poll_completed', {
        polled: routers.length,
        succeeded,
        failed
    });

    return {
        polled: routers.length,
        succeeded,
        failed,
        results: settled.map((item, index) => ({
            routerId: String(routers[index]._id),
            success: item.status === 'fulfilled',
            metric: item.status === 'fulfilled' ? item.value : null,
            error: item.status === 'rejected' ? (item.reason?.message || String(item.reason)) : null
        }))
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
