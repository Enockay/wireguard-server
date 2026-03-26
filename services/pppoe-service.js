const bcrypt = require('bcryptjs');
const MikrotikRouter = require('../models/MikrotikRouter');
const PppoeSecret = require('../models/PppoeSecret');
const PppoeSession = require('../models/PppoeSession');
const { executeCommand } = require('./routeros-command-service');

function toNumber(value) {
    if (value == null || value === '') return 0;
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
}

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeSecret(doc, activeNames = new Set()) {
    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        name: doc.name,
        profile: doc.profile || 'default',
        service: doc.service || 'pppoe',
        localAddress: doc.localAddress || '',
        remoteAddress: doc.remoteAddress || '',
        comment: doc.comment || '',
        isDisabled: Boolean(doc.isDisabled),
        online: activeNames.has(doc.name),
        routerosId: doc.routerosId || '',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

function serializeSession(doc) {
    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        name: doc.name || '',
        service: doc.service || '',
        callerIp: doc.callerIp || '',
        address: doc.address || '',
        uptime: doc.uptime || '',
        bytesIn: doc.bytesIn || 0,
        bytesOut: doc.bytesOut || 0,
        sessionId: doc.sessionId || '',
        connectedAt: doc.connectedAt || doc.createdAt || null,
        isActive: Boolean(doc.isActive),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

function serializeProfile(record) {
    return {
        name: record.name || 'default',
        localAddress: record['local-address'] || '',
        remoteAddress: record['remote-address'] || '',
        rateLimit: record['rate-limit'] || '',
        comment: record.comment || ''
    };
}

async function ensureRouterExists(routerId) {
    const router = await MikrotikRouter.findById(routerId).select('_id');
    if (!router) {
        throw new Error('Router not found');
    }
    return router;
}

async function fetchRouterSecret(routerId, name) {
    const records = await executeCommand(routerId, '/ppp/secret/print', {}, { operationName: 'get_system_resource' });
    return records.find((item) => item.name === name) || null;
}

async function syncSecrets(routerId, records) {
    if (!records.length) return;
    const operations = records.map((record) => ({
        updateOne: {
            filter: { routerId, name: record.name },
            update: {
                $set: {
                    profile: record.profile || 'default',
                    service: record.service || 'pppoe',
                    callerIdFilter: record['caller-id'] || '*',
                    localAddress: record['local-address'] || '',
                    remoteAddress: record['remote-address'] || '',
                    comment: record.comment || '',
                    isDisabled: ['yes', 'true'].includes(String(record.disabled || '').toLowerCase()),
                    routerosId: record['.id'] || ''
                },
                $setOnInsert: {
                    createdBy: 'router-sync'
                }
            },
            upsert: true
        }
    }));
    await PppoeSecret.bulkWrite(operations, { ordered: false });
}

async function syncSessions(routerId, records) {
    const sessionIds = records.map((item) => item['.id']).filter(Boolean);
    if (sessionIds.length) {
        const operations = records.map((record) => ({
            updateOne: {
                filter: { routerId, sessionId: record['.id'] },
                update: {
                    $set: {
                        name: record.name || '',
                        service: record.service || '',
                        callerIp: record.caller || '',
                        address: record.address || '',
                        uptime: record.uptime || '',
                        bytesIn: toNumber(record['bytes-in']),
                        bytesOut: toNumber(record['bytes-out']),
                        isActive: true
                    },
                    $setOnInsert: {
                        connectedAt: new Date()
                    }
                },
                upsert: true
            }
        }));
        await PppoeSession.bulkWrite(operations, { ordered: false });
    }

    await PppoeSession.updateMany(
        {
            routerId,
            isActive: true,
            ...(sessionIds.length ? { sessionId: { $nin: sessionIds } } : {})
        },
        {
            $set: {
                isActive: false
            }
        }
    );
}

async function listPppoeSecrets(routerId, page = 1, limit = 50, search = '') {
    await ensureRouterExists(routerId);
    const [secretRecords, activeRecords] = await Promise.all([
        executeCommand(routerId, '/ppp/secret/print', {}, { operationName: 'get_system_resource' }),
        executeCommand(routerId, '/ppp/active/print', {}, { operationName: 'get_system_resource' }).catch(() => [])
    ]);
    await syncSecrets(routerId, secretRecords);
    await syncSessions(routerId, activeRecords);

    const activeNames = new Set((activeRecords || []).map((item) => item.name).filter(Boolean));
    const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : null;
    const filter = {
        routerId,
        ...(searchRegex ? { $or: [{ name: searchRegex }, { comment: searchRegex }] } : {})
    };
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const total = await PppoeSecret.countDocuments(filter);
    const items = await PppoeSecret.find(filter)
        .sort({ createdAt: -1, name: 1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit);

    return {
        items: items.map((item) => serializeSecret(item, activeNames)),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.max(1, Math.ceil(total / safeLimit))
        }
    };
}

async function createPppoeSecret(routerId, payload) {
    await ensureRouterExists(routerId);
    const {
        name,
        password,
        profile = 'default',
        service = 'pppoe',
        localAddress = '',
        remoteAddress = '',
        comment = ''
    } = payload;

    await executeCommand(routerId, '/ppp/secret/add', {
        name,
        password,
        profile,
        service,
        'local-address': localAddress || '',
        'remote-address': remoteAddress || '',
        comment
    }, { operationName: 'pppoe_mutation', scope: 'pppoe' });

    const record = await fetchRouterSecret(routerId, name);
    const secret = await PppoeSecret.findOneAndUpdate(
        { routerId, name },
        {
            $set: {
                password: password ? await bcrypt.hash(password, 10) : '',
                profile,
                service,
                localAddress,
                remoteAddress,
                comment,
                isDisabled: false,
                routerosId: record?.['.id'] || ''
            },
            $setOnInsert: {
                createdBy: 'admin'
            }
        },
        { new: true, upsert: true }
    );

    return serializeSecret(secret);
}

async function updatePppoeSecret(routerId, routerosId, updates) {
    await ensureRouterExists(routerId);
    const secret = await PppoeSecret.findOne({ routerId, routerosId });
    if (!secret) {
        throw new Error('PPPoE subscriber not found');
    }

    const commandAttributes = { '.id': routerosId };
    const dbUpdates = {};
    if (updates.name) {
        commandAttributes.name = updates.name;
        dbUpdates.name = updates.name;
    }
    if (updates.password) {
        commandAttributes.password = updates.password;
        dbUpdates.password = await bcrypt.hash(updates.password, 10);
    }
    if (updates.profile != null) {
        commandAttributes.profile = updates.profile || 'default';
        dbUpdates.profile = updates.profile || 'default';
    }
    if (updates.service != null) {
        commandAttributes.service = updates.service || 'pppoe';
        dbUpdates.service = updates.service || 'pppoe';
    }
    if (updates.localAddress != null) {
        commandAttributes['local-address'] = updates.localAddress || '';
        dbUpdates.localAddress = updates.localAddress || '';
    }
    if (updates.remoteAddress != null) {
        commandAttributes['remote-address'] = updates.remoteAddress || '';
        dbUpdates.remoteAddress = updates.remoteAddress || '';
    }
    if (updates.comment != null) {
        commandAttributes.comment = updates.comment || '';
        dbUpdates.comment = updates.comment || '';
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'isDisabled')) {
        commandAttributes.disabled = updates.isDisabled ? 'yes' : 'no';
        dbUpdates.isDisabled = Boolean(updates.isDisabled);
    }

    await executeCommand(routerId, '/ppp/secret/set', commandAttributes, { operationName: 'pppoe_mutation', scope: 'pppoe' });
    const updated = await PppoeSecret.findOneAndUpdate({ routerId, routerosId }, { $set: dbUpdates }, { new: true });
    return serializeSecret(updated);
}

async function deletePppoeSecret(routerId, routerosId, secretId) {
    await ensureRouterExists(routerId);
    await executeCommand(routerId, '/ppp/secret/remove', { '.id': routerosId }, { operationName: 'pppoe_mutation', scope: 'pppoe' });
    await PppoeSecret.findOneAndUpdate({ _id: secretId, routerId }, { $set: { isDisabled: true } });
    return { message: 'PPPoE subscriber deleted' };
}

async function listActiveSessions(routerId) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/ppp/active/print', {}, { operationName: 'get_system_resource' });
    await syncSessions(routerId, records);
    const sessions = await PppoeSession.find({ routerId, isActive: true }).sort({ createdAt: -1 });
    return sessions.map(serializeSession);
}

async function disconnectSession(routerId, sessionId) {
    await ensureRouterExists(routerId);
    await executeCommand(routerId, '/ppp/active/remove', { '.id': sessionId }, { operationName: 'safe_operational', scope: 'pppoe' });
    await PppoeSession.findOneAndUpdate({ routerId, sessionId }, { $set: { isActive: false } });
    return { message: 'PPPoE session disconnected' };
}

async function listProfiles(routerId) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/ppp/profile/print', {}, { operationName: 'get_system_resource' });
    return records.map(serializeProfile);
}

async function createProfile(routerId, payload) {
    await ensureRouterExists(routerId);
    const {
        name,
        localAddress = '',
        remoteAddress = '',
        rateLimit = '',
        comment = ''
    } = payload;
    await executeCommand(routerId, '/ppp/profile/add', {
        name,
        'local-address': localAddress || '',
        'remote-address': remoteAddress || '',
        'rate-limit': rateLimit || '',
        comment
    }, { operationName: 'pppoe_mutation', scope: 'pppoe' });
    return {
        name,
        localAddress,
        remoteAddress,
        rateLimit,
        comment
    };
}

async function updateProfile(routerId, profileId, payload) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/ppp/profile/print', {}, { operationName: 'get_system_resource' });
    const profile = records.find((item) => item['.id'] === profileId || item.name === profileId);
    if (!profile) {
        throw new Error('PPPoE profile not found');
    }

    const nextName = payload.name != null ? String(payload.name || '').trim() : profile.name || 'default';
    const nextLocalAddress = payload.localAddress != null ? payload.localAddress || '' : profile['local-address'] || '';
    const nextRemoteAddress = payload.remoteAddress != null ? payload.remoteAddress || '' : profile['remote-address'] || '';
    const nextRateLimit = payload.rateLimit != null ? payload.rateLimit || '' : profile['rate-limit'] || '';
    const nextComment = payload.comment != null ? payload.comment || '' : profile.comment || '';

    await executeCommand(routerId, '/ppp/profile/set', {
        '.id': profile['.id'],
        name: nextName,
        'local-address': nextLocalAddress,
        'remote-address': nextRemoteAddress,
        'rate-limit': nextRateLimit,
        comment: nextComment
    }, { operationName: 'pppoe_mutation', scope: 'pppoe' });

    return {
        id: profile['.id'] || '',
        name: nextName,
        localAddress: nextLocalAddress,
        remoteAddress: nextRemoteAddress,
        rateLimit: nextRateLimit,
        comment: nextComment
    };
}

async function deleteProfile(routerId, profileId) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/ppp/profile/print', {}, { operationName: 'get_system_resource' });
    const profile = records.find((item) => item['.id'] === profileId || item.name === profileId);
    if (!profile) {
        throw new Error('PPPoE profile not found');
    }

    await executeCommand(routerId, '/ppp/profile/remove', { '.id': profile['.id'] }, { operationName: 'pppoe_mutation', scope: 'pppoe' });
    return { message: 'PPPoE profile deleted' };
}

module.exports = {
    listPppoeSecrets,
    createPppoeSecret,
    updatePppoeSecret,
    deletePppoeSecret,
    listActiveSessions,
    disconnectSession,
    listProfiles,
    createProfile,
    updateProfile,
    deleteProfile
};
