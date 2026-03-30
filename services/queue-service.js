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

function formatRouterOsRate(kbps) {
    const normalized = Math.max(0, Number(kbps) || 0);
    if (!normalized) return '0';
    const format = (value) => String(Number(value.toFixed(3)));
    if (normalized >= 1000000 && normalized % 1000000 === 0) return `${format(normalized / 1000000)}G`;
    if (normalized >= 1000) return `${format(normalized / 1000)}M`;
    return `${format(normalized)}k`;
}

function parseRouterOsRate(value) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized === '0') return 0;
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)([kKmMgG])?$/);
    if (!match) return toNumber(normalized);
    const amount = Number(match[1]) || 0;
    const unit = (match[2] || '').toLowerCase();
    if (unit === 'g') return Math.round(amount * 1000000);
    if (unit === 'm') return Math.round(amount * 1000);
    if (unit === 'k') return Math.round(amount);
    return Math.round(amount / 1000);
}

function buildMaxLimit(downloadKbps, uploadKbps) {
    const maxDownloadKbps = Math.max(0, Number(downloadKbps) || 0);
    const maxUploadKbps = Math.max(0, Number(uploadKbps) || 0);
    return `${formatRouterOsRate(maxUploadKbps)}/${formatRouterOsRate(maxDownloadKbps)}`;
}

function parseMaxLimit(value) {
    const [upload, download] = String(value || '0k/0k').split('/');
    return {
        maxUploadKbps: parseRouterOsRate(upload),
        maxDownloadKbps: parseRouterOsRate(download)
    };
}

function normalizeQueueTarget(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    return normalized.split(',')[0].trim();
}

function sanitizeQueueNameFragment(value) {
    return String(value || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function buildUniqueQueueName(baseName, target) {
    const sanitizedBase = sanitizeQueueNameFragment(baseName) || 'queue';
    const sanitizedTarget = sanitizeQueueNameFragment(normalizeQueueTarget(target).replace(/\//g, '-')) || 'target';
    return `${sanitizedBase}-${sanitizedTarget}`.slice(0, 60);
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
        isDynamic: Boolean(doc.isDynamic),
        linkedSubscriptionId: doc.linkedSubscriptionId ? String(doc.linkedSubscriptionId) : null,
        linkedServicePlanId: doc.linkedServicePlanId ? String(doc.linkedServicePlanId) : null,
        overrideSourceType: doc.overrideSourceType || '',
        overrideSourceId: doc.overrideSourceId || '',
        overrideSourceName: doc.overrideSourceName || '',
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

async function fetchRouterQueueById(routerId, routerosId) {
    const records = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    return records.find((item) => String(item['.id'] || '').trim() === String(routerosId || '').trim()) || null;
}

function findNewlyCreatedQueueRecord(records = [], previousRouterosIds = new Set(), matcher = {}) {
    const expectedName = String(matcher.name || '').trim();
    const expectedTarget = String(matcher.target || '').trim();

    return records.find((record) => {
        const recordId = String(record['.id'] || '').trim();
        if (!recordId || previousRouterosIds.has(recordId)) {
            return false;
        }
        if (expectedName && String(record.name || '').trim() !== expectedName) {
            return false;
        }
        if (expectedTarget && String(record.target || '').trim() !== expectedTarget) {
            return false;
        }
        return true;
    }) || null;
}

function findQueueByName(records = [], name) {
    const expected = String(name || '').trim();
    if (!expected) return null;
    return records.find((record) => String(record.name || '').trim() === expected) || null;
}

function isTruthyRouterOsFlag(value) {
    return ['true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function isDynamicQueueRecord(record = {}) {
    return isTruthyRouterOsFlag(record.dynamic);
}

function findConflictingQueuePlacement(records = [], target, currentRouterosId = null) {
    const normalizedTarget = normalizeQueueTarget(target);
    if (!normalizedTarget) return null;

    const matching = records.find((record) => {
        const recordId = String(record['.id'] || '').trim();
        if (!recordId || (currentRouterosId && recordId === String(currentRouterosId).trim())) {
            return false;
        }
        return normalizeQueueTarget(record.target || '') === normalizedTarget && isDynamicQueueRecord(record);
    });

    return matching ? String(matching['.id'] || '').trim() : null;
}

async function positionQueueBeforeConflict(routerId, routerosId, target) {
    const records = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    const destination = findConflictingQueuePlacement(records, target, routerosId);
    if (!destination) {
        return false;
    }
    await executeCommand(
        routerId,
        '/queue/simple/move',
        { numbers: String(routerosId || '').trim(), destination },
        { operationName: 'queue_mutation', scope: 'queues' }
    );
    return true;
}

async function syncQueues(routerId, records) {
    const activeRouterosIds = records
        .map((record) => String(record['.id'] || '').trim())
        .filter(Boolean);

    if (!records.length) {
        await RouterQueue.updateMany({ routerId, isActive: true }, { $set: { isActive: false } });
        return;
    }

    const operations = records.map((record) => {
        const parsed = parseMaxLimit(record['max-limit']);
        const queueProfiles = String(record.queue || '').split('/');
        const routerosId = String(record['.id'] || '').trim();
        const target = record.target || '';
        const name = record.name || 'unnamed-queue';
        return {
            updateOne: {
                filter: routerosId
                    ? { routerId, routerosId }
                    : { routerId, target: target || name, name },
                update: {
                    $set: {
                        name,
                        target,
                        maxDownloadKbps: parsed.maxDownloadKbps,
                        maxUploadKbps: parsed.maxUploadKbps,
                        comment: record.comment || '',
                        routerosId,
                        isDynamic: isDynamicQueueRecord(record),
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
    await RouterQueue.updateMany(
        { routerId, routerosId: { $nin: activeRouterosIds } },
        { $set: { isActive: false } }
    );
    const duplicateActiveQueues = await RouterQueue.find({
        routerId,
        routerosId: { $in: activeRouterosIds }
    }).sort({ updatedAt: -1, createdAt: -1, _id: -1 });

    const seenRouterosIds = new Set();
    const duplicateIds = [];
    for (const queue of duplicateActiveQueues) {
        const key = String(queue.routerosId || '').trim();
        if (!key) continue;
        if (seenRouterosIds.has(key)) {
            duplicateIds.push(queue._id);
            continue;
        }
        seenRouterosIds.add(key);
    }

    if (duplicateIds.length) {
        await RouterQueue.updateMany({ _id: { $in: duplicateIds } }, { $set: { isActive: false } });
    }
}

async function listQueues(routerId, page = 1, limit = 50) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    await syncQueues(routerId, records);

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const activeQuery = { routerId, isActive: true };
    const total = await RouterQueue.countDocuments(activeQuery);
    const items = await RouterQueue.find(activeQuery)
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
        overrideSourceType = '',
        overrideSourceId = '',
        overrideSourceName = '',
        queueType = 'simple',
        pcqDownloadProfile = '',
        pcqUploadProfile = ''
    } = payload;

    const existingRecords = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    const existingRouterosIds = new Set(existingRecords.map((record) => String(record['.id'] || '').trim()).filter(Boolean));
    const placeBefore = findConflictingQueuePlacement(existingRecords, target);
    const existingWithName = findQueueByName(existingRecords, name);

    if (existingWithName && !isDynamicQueueRecord(existingWithName)) {
        return updateQueue(routerId, String(existingWithName['.id'] || '').trim(), {
            name,
            target,
            maxDownloadKbps,
            maxUploadKbps,
            comment,
            linkedSubscriptionId,
            linkedServicePlanId,
            overrideSourceType,
            overrideSourceId,
            overrideSourceName,
            queueType,
            pcqDownloadProfile,
            pcqUploadProfile
        });
    }

    const effectiveName = existingWithName ? buildUniqueQueueName(name, target) : name;

    const attributes = {
        name: effectiveName,
        target,
        'max-limit': buildMaxLimit(maxDownloadKbps, maxUploadKbps),
        comment
    };
    if (placeBefore) {
        attributes['place-before'] = placeBefore;
    }
    if (queueType === 'pcq' && (pcqDownloadProfile || pcqUploadProfile)) {
        attributes.queue = `${pcqUploadProfile || 'default'}/${pcqDownloadProfile || 'default'}`;
    }

    await executeCommand(routerId, '/queue/simple/add', attributes, { operationName: 'queue_mutation', scope: 'queues' });
    const postCreateRecords = await executeCommand(routerId, '/queue/simple/print', {}, { operationName: 'get_system_resource' });
    const record = findNewlyCreatedQueueRecord(postCreateRecords, existingRouterosIds, { name: effectiveName, target });
    const queue = await RouterQueue.create({
        routerId,
        name: effectiveName,
        target,
        maxDownloadKbps,
        maxUploadKbps,
        comment,
        routerosId: record?.['.id'] || '',
        linkedSubscriptionId,
        linkedServicePlanId,
        overrideSourceType: overrideSourceType || undefined,
        overrideSourceId: overrideSourceId || undefined,
        overrideSourceName: overrideSourceName || undefined,
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
    if (queue.isDynamic) {
        throw new Error('Dynamic queues cannot be edited directly; update the source profile or create a static queue instead');
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
    await positionQueueBeforeConflict(routerId, routerosId, updates.target != null ? updates.target : queue.target);
    const liveRecord = await fetchRouterQueueById(routerId, routerosId);
    if (!liveRecord) {
        throw new Error('Queue update could not be verified on the router');
    }
    const verifiedLimits = parseMaxLimit(liveRecord['max-limit']);
    const expectedQueueValue = nextType === 'pcq' && (nextPcqDownload || nextPcqUpload)
        ? `${nextPcqUpload || 'default'}/${nextPcqDownload || 'default'}`
        : null;
    const liveQueueValue = String(liveRecord.queue || '');
    if (
        verifiedLimits.maxDownloadKbps !== nextDownload
        || verifiedLimits.maxUploadKbps !== nextUpload
        || (expectedQueueValue != null && liveQueueValue !== expectedQueueValue)
    ) {
        throw new Error('Queue update was not applied on the router');
    }
    const updated = await RouterQueue.findOneAndUpdate(
        { routerId, routerosId },
        {
            $set: {
                ...(updates.name != null ? { name: updates.name } : {}),
                ...(updates.target != null ? { target: updates.target } : {}),
                ...(updates.comment != null ? { comment: updates.comment || '' } : {}),
                maxDownloadKbps: nextDownload,
                maxUploadKbps: nextUpload,
                ...(updates.linkedSubscriptionId !== undefined ? { linkedSubscriptionId: updates.linkedSubscriptionId || null } : {}),
                ...(updates.linkedServicePlanId !== undefined ? { linkedServicePlanId: updates.linkedServicePlanId || null } : {}),
                ...(updates.overrideSourceType !== undefined ? { overrideSourceType: updates.overrideSourceType || undefined } : {}),
                ...(updates.overrideSourceId !== undefined ? { overrideSourceId: updates.overrideSourceId || undefined } : {}),
                ...(updates.overrideSourceName !== undefined ? { overrideSourceName: updates.overrideSourceName || undefined } : {}),
                isDynamic: isDynamicQueueRecord(liveRecord),
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
    const queue = await RouterQueue.findOne({ _id: queueId, routerId });
    if (!queue) {
        throw new Error('Queue not found');
    }
    if (queue.isDynamic) {
        throw new Error('Dynamic queues cannot be deleted directly; remove the source profile or service that generated them');
    }
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
        const updatedQueue = await updateQueue(routerId, existing.routerosId, {
            maxDownloadKbps: servicePlan.speedDownloadKbps || 0,
            maxUploadKbps: servicePlan.speedUploadKbps || 0,
            comment: existing.comment || `Applied from service plan ${servicePlan.name}`,
            linkedSubscriptionId: subscriptionId || existing.linkedSubscriptionId || null,
            linkedServicePlanId: servicePlan._id || servicePlan.id || null,
        });
        if (subscriptionId) {
            await Subscription.findByIdAndUpdate(subscriptionId, {
                servicePlanId: servicePlan._id || servicePlan.id || null,
                subscriberIp,
                queueName: updatedQueue.name
            }).catch(() => undefined);
        }
        return updatedQueue;
    }

    const createdQueue = await createQueue(routerId, {
        name: `sub-${subscriptionId || subscriberIp.replace(/[^\w-]/g, '-')}`,
        target: subscriberIp,
        maxDownloadKbps: servicePlan.speedDownloadKbps || 0,
        maxUploadKbps: servicePlan.speedUploadKbps || 0,
        comment: `Applied from service plan ${servicePlan.name}`,
        linkedSubscriptionId: subscriptionId || null,
        linkedServicePlanId: servicePlan._id || servicePlan.id || null
    });
    if (subscriptionId) {
        await Subscription.findByIdAndUpdate(subscriptionId, {
            servicePlanId: servicePlan._id || servicePlan.id || null,
            subscriberIp,
            queueName: createdQueue.name
        }).catch(() => undefined);
    }
    return createdQueue;
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
