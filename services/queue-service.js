const MikrotikRouter = require('../models/MikrotikRouter');
const RouterQueue = require('../models/RouterQueue');
const ServicePlan = require('../models/ServicePlan');
const Subscription = require('../models/Subscription');
const { executeCommand } = require('./routeros-command-service');

function toNumber(value) {
    if (value == null || value === '') return 0;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
}

function buildMaxLimit(downloadKbps, uploadKbps) {
    const maxDownloadKbps = Math.max(0, Number(downloadKbps) || 0);
    const maxUploadKbps = Math.max(0, Number(uploadKbps) || 0);
    return `${maxUploadKbps}k/${maxDownloadKbps}k`;
}

function parseMaxLimit(value) {
    const [upload, download] = String(value || '0k/0k').split('/');
    return {
        maxUploadKbps: toNumber(upload),
        maxDownloadKbps: toNumber(download)
    };
}

function serializeQueue(doc) {
    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        name: doc.name,
        target: doc.target || '',
        maxDownloadKbps: doc.maxDownloadKbps || 0,
        maxUploadKbps: doc.maxUploadKbps || 0,
        burstDownloadKbps: doc.burstDownloadKbps || 0,
        burstUploadKbps: doc.burstUploadKbps || 0,
        comment: doc.comment || '',
        routerosId: doc.routerosId || '',
        linkedSubscriptionId: doc.linkedSubscriptionId ? String(doc.linkedSubscriptionId) : null,
        linkedServicePlanId: doc.linkedServicePlanId ? String(doc.linkedServicePlanId) : null,
        queueType: doc.queueType || 'simple',
        pcqDownloadProfile: doc.pcqDownloadProfile || '',
        pcqUploadProfile: doc.pcqUploadProfile || '',
        isActive: Boolean(doc.isActive),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

async function ensureRouterExists(routerId) {
    const router = await MikrotikRouter.findById(routerId).select('_id vpnIp');
    if (!router) {
        throw new Error('Router not found');
    }
    return router;
}

async function fetchRouterQueue(routerId, name) {
    const records = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    return records.find((item) => item.name === name) || null;
}

async function syncQueues(routerId, records) {
    if (!records.length) return;

    const operations = records.map((record) => {
        const parsed = parseMaxLimit(record['max-limit']);
        const queueProfiles = String(record.queue || '').split('/');
        return {
            updateOne: {
                filter: { routerId, target: record.target || record.name || '' },
                update: {
                    $set: {
                        name: record.name || 'unnamed-queue',
                        target: record.target || '',
                        maxDownloadKbps: parsed.maxDownloadKbps,
                        maxUploadKbps: parsed.maxUploadKbps,
                        comment: record.comment || '',
                        routerosId: record['.id'] || '',
                        queueType: record.queue ? 'pcq' : 'simple',
                        pcqUploadProfile: queueProfiles[0] || '',
                        pcqDownloadProfile: queueProfiles[1] || '',
                        isActive: !['yes', 'true'].includes(String(record.disabled || '').toLowerCase())
                    },
                    $setOnInsert: {
                        createdBy: 'router-sync'
                    }
                },
                upsert: true
            }
        };
    });

    await RouterQueue.bulkWrite(operations, { ordered: false });
}

async function listQueues(routerId, page = 1, limit = 50) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    await syncQueues(routerId, records);

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const total = await RouterQueue.countDocuments({ routerId });
    const items = await RouterQueue.find({ routerId })
        .sort({ createdAt: -1, name: 1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit);

    return {
        items: items.map(serializeQueue),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.max(1, Math.ceil(total / safeLimit))
        }
    };
}

async function createQueue(routerId, payload) {
    await ensureRouterExists(routerId);
    const {
        name,
        target,
        maxDownloadKbps = 0,
        maxUploadKbps = 0,
        comment = '',
        linkedSubscriptionId = null,
        linkedServicePlanId = null,
        queueType = 'simple',
        pcqDownloadProfile = '',
        pcqUploadProfile = ''
    } = payload;

    const attributes = {
        name,
        target,
        'max-limit': buildMaxLimit(maxDownloadKbps, maxUploadKbps),
        comment
    };
    if (queueType === 'pcq' && (pcqDownloadProfile || pcqUploadProfile)) {
        attributes.queue = `${pcqUploadProfile || 'default'}/${pcqDownloadProfile || 'default'}`;
    }

    await executeCommand(routerId, '/queue/simple/add', attributes, { operationName: 'queue_mutation', scope: 'queues' });
    const record = await fetchRouterQueue(routerId, name);
    const queue = await RouterQueue.create({
        routerId,
        name,
        target,
        maxDownloadKbps,
        maxUploadKbps,
        comment,
        routerosId: record?.['.id'] || '',
        linkedSubscriptionId,
        linkedServicePlanId,
        queueType,
        pcqDownloadProfile,
        pcqUploadProfile,
        isActive: true,
        createdBy: linkedSubscriptionId ? 'subscription-lifecycle' : 'admin'
    });

    return serializeQueue(queue);
}

async function updateQueue(routerId, routerosId, updates) {
    await ensureRouterExists(routerId);
    const queue = await RouterQueue.findOne({ routerId, routerosId });
    if (!queue) {
        throw new Error('Queue not found');
    }

    const nextDownload = updates.maxDownloadKbps != null ? Number(updates.maxDownloadKbps) || 0 : queue.maxDownloadKbps;
    const nextUpload = updates.maxUploadKbps != null ? Number(updates.maxUploadKbps) || 0 : queue.maxUploadKbps;
    const nextType = updates.queueType || queue.queueType || 'simple';
    const nextPcqDownload = updates.pcqDownloadProfile != null ? updates.pcqDownloadProfile : queue.pcqDownloadProfile;
    const nextPcqUpload = updates.pcqUploadProfile != null ? updates.pcqUploadProfile : queue.pcqUploadProfile;

    const attributes = {
        '.id': routerosId,
        'max-limit': buildMaxLimit(nextDownload, nextUpload)
    };
    if (updates.name != null) attributes.name = updates.name;
    if (updates.target != null) attributes.target = updates.target;
    if (updates.comment != null) attributes.comment = updates.comment || '';
    if (nextType === 'pcq' && (nextPcqDownload || nextPcqUpload)) {
        attributes.queue = `${nextPcqUpload || 'default'}/${nextPcqDownload || 'default'}`;
    }

    await executeCommand(routerId, '/queue/simple/set', attributes, { operationName: 'queue_mutation', scope: 'queues' });
    const updated = await RouterQueue.findOneAndUpdate(
        { routerId, routerosId },
        {
            $set: {
                ...(updates.name != null ? { name: updates.name } : {}),
                ...(updates.target != null ? { target: updates.target } : {}),
                ...(updates.comment != null ? { comment: updates.comment || '' } : {}),
                maxDownloadKbps: nextDownload,
                maxUploadKbps: nextUpload,
                queueType: nextType,
                pcqDownloadProfile: nextPcqDownload || '',
                pcqUploadProfile: nextPcqUpload || ''
            }
        },
        { new: true }
    );

    return serializeQueue(updated);
}

async function deleteQueue(routerId, routerosId, queueId) {
    await ensureRouterExists(routerId);
    await executeCommand(routerId, '/queue/simple/remove', { '.id': routerosId }, { operationName: 'queue_mutation', scope: 'queues' });
    await RouterQueue.findOneAndUpdate({ _id: queueId, routerId }, { $set: { isActive: false } });
    return { message: 'Queue removed' };
}

async function resolveServicePlan(servicePlanOrId) {
    if (!servicePlanOrId) {
        return null;
    }
    if (servicePlanOrId.speedDownloadKbps != null) {
        return servicePlanOrId;
    }
    return ServicePlan.findById(servicePlanOrId);
}

async function applyPlanToSubscriber(routerId, subscriberIp, servicePlanOrId, subscriptionId = null) {
    const servicePlan = await resolveServicePlan(servicePlanOrId);
    if (!servicePlan) {
        throw new Error('Service plan not found');
    }

    const existing = await RouterQueue.findOne({ routerId, target: subscriberIp, isActive: true }).sort({ createdAt: -1 });
    if (existing?.routerosId) {
        return updateQueue(routerId, existing.routerosId, {
            maxDownloadKbps: servicePlan.speedDownloadKbps || 0,
            maxUploadKbps: servicePlan.speedUploadKbps || 0,
            comment: existing.comment || `Applied from service plan ${servicePlan.name}`,
        });
    }

    return createQueue(routerId, {
        name: `sub-${subscriptionId || subscriberIp.replace(/[^\w-]/g, '-')}`,
        target: subscriberIp,
        maxDownloadKbps: servicePlan.speedDownloadKbps || 0,
        maxUploadKbps: servicePlan.speedUploadKbps || 0,
        comment: `Applied from service plan ${servicePlan.name}`,
        linkedSubscriptionId: subscriptionId || null,
        linkedServicePlanId: servicePlan._id || servicePlan.id || null
    });
}

async function removePlanFromSubscriber(routerId, subscriberIp) {
    const queue = await RouterQueue.findOne({ routerId, target: subscriberIp, isActive: true }).sort({ createdAt: -1 });
    if (!queue || !queue.routerosId) {
        return { message: 'No active queue found for subscriber' };
    }
    return deleteQueue(routerId, queue.routerosId, queue._id);
}

async function getQueueStats(routerId) {
    const queues = await RouterQueue.find({ routerId, isActive: true });
    return {
        total: queues.length,
        active: queues.filter((item) => item.isActive).length,
        totalDownloadKbps: queues.reduce((sum, item) => sum + (item.maxDownloadKbps || 0), 0),
        totalUploadKbps: queues.reduce((sum, item) => sum + (item.maxUploadKbps || 0), 0)
    };
}

module.exports = {
    listQueues,
    createQueue,
    updateQueue,
    deleteQueue,
    applyPlanToSubscriber,
    removePlanFromSubscriber,
    getQueueStats
};
