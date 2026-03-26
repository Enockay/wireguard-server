const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const HotspotUser = require('../models/HotspotUser');
const HotspotSession = require('../models/HotspotSession');
const HotspotVoucher = require('../models/HotspotVoucher');
const MikrotikRouter = require('../models/MikrotikRouter');
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

function parseDurationToSeconds(value) {
    if (!value) return 0;
    const normalized = String(value).trim();
    if (!normalized) return 0;
    if (/^\d+$/.test(normalized)) {
        return Number(normalized) || 0;
    }
    if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(normalized)) {
        const parts = normalized.split(':').map((part) => Number(part) || 0);
        if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        if (parts.length === 2) return (parts[0] * 60) + parts[1];
    }

    const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
    const matches = normalized.toLowerCase().matchAll(/(\d+)([wdhms])/g);
    let total = 0;
    for (const match of matches) {
        total += (Number(match[1]) || 0) * (units[match[2]] || 0);
    }
    return total;
}

function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    if (total <= 0) return undefined;

    const parts = [];
    let remaining = total;
    const units = [
        ['w', 604800],
        ['d', 86400],
        ['h', 3600],
        ['m', 60],
        ['s', 1]
    ];

    for (const [suffix, size] of units) {
        if (remaining >= size) {
            const count = Math.floor(remaining / size);
            parts.push(`${count}${suffix}`);
            remaining -= count * size;
        }
    }

    return parts.join('') || undefined;
}

function serializeHotspotUser(doc, activeUsernames = new Set()) {
    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        username: doc.username,
        profile: doc.profile || 'default',
        isActive: Boolean(doc.isActive),
        online: activeUsernames.has(doc.username),
        bytesIn: doc.bytesIn || 0,
        bytesOut: doc.bytesOut || 0,
        dataLimitBytes: doc.dataLimitBytes || 0,
        timeLimitSeconds: doc.timeLimitSeconds || 0,
        expiresAt: doc.expiresAt || null,
        comment: doc.comment || '',
        routerosId: doc.routerosId || '',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

function serializeHotspotSession(doc) {
    const uptimeSeconds = doc.uptimeSeconds || 0;
    const averageUplinkBps = uptimeSeconds > 0 ? Math.round((doc.uplinkBytes || 0) / uptimeSeconds) : 0;
    const averageDownlinkBps = uptimeSeconds > 0 ? Math.round((doc.downlinkBytes || 0) / uptimeSeconds) : 0;

    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        hotspotUserId: doc.hotspotUserId ? String(doc.hotspotUserId) : null,
        username: doc.username || '',
        ip: doc.ip || '',
        mac: doc.mac || '',
        uplinkBytes: doc.uplinkBytes || 0,
        downlinkBytes: doc.downlinkBytes || 0,
        currentUplinkBps: doc.currentUplinkBps || 0,
        currentDownlinkBps: doc.currentDownlinkBps || 0,
        uptimeSeconds,
        sessionTimeLeftSeconds: doc.sessionTimeLeftSeconds || 0,
        idleTimeoutSeconds: doc.idleTimeoutSeconds || 0,
        keepaliveTimeoutSeconds: doc.keepaliveTimeoutSeconds || 0,
        server: doc.server || 'default',
        hostName: doc.hostName || '',
        deviceLabel: doc.deviceLabel || doc.hostName || doc.mac || doc.ip || '',
        profile: doc.profile || '',
        averageUplinkBps,
        averageDownlinkBps,
        sessionId: doc.sessionId || '',
        startedAt: doc.startedAt || doc.createdAt || null,
        endedAt: doc.endedAt || null,
        isActive: Boolean(doc.isActive),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

function serializeHotspotProfile(record) {
    return {
        name: record.name || 'default',
        rateLimit: record['rate-limit'] || '',
        sessionTimeout: record['session-timeout'] || '',
        idleTimeout: record['idle-timeout'] || ''
    };
}

function serializeVoucher(doc) {
    const isExpired = doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now();
    const status = doc.status === 'unused' && isExpired ? 'expired' : doc.status;

    return {
        id: String(doc._id),
        routerId: String(doc.routerId),
        hotspotUserId: doc.hotspotUserId ? String(doc.hotspotUserId) : null,
        username: doc.username,
        password: doc.password,
        profile: doc.profile || 'default',
        dataLimitBytes: doc.dataLimitBytes || 0,
        timeLimitSeconds: doc.timeLimitSeconds || 0,
        comment: doc.comment || '',
        batchId: doc.batchId || '',
        status,
        expiresAt: doc.expiresAt || null,
        usedAt: doc.usedAt || null,
        revokedAt: doc.revokedAt || null,
        createdBy: doc.createdBy || 'system',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
}

async function ensureRouterExists(routerId) {
    const router = await MikrotikRouter.findById(routerId).select('_id name');
    if (!router) {
        throw new Error('Router not found');
    }
    return router;
}

async function fetchRouterHotspotUserRecord(routerId, username) {
    const records = await executeCommand(routerId, '/ip/hotspot/user/print', {}, { operationName: 'get_system_resource' });
    return records.find((item) => item.name === username) || null;
}

async function fetchDhcpLeases(routerId) {
    const records = await executeCommand(routerId, '/ip/dhcp-server/lease/print', {}, { operationName: 'get_system_resource' }).catch(() => []);
    const byIp = new Map();
    const byMac = new Map();

    for (const record of records || []) {
        const lease = {
            address: record.address || '',
            mac: String(record['mac-address'] || '').toUpperCase(),
            hostName: record['host-name'] || '',
            comment: record.comment || ''
        };

        if (lease.address && !byIp.has(lease.address)) byIp.set(lease.address, lease);
        if (lease.mac && !byMac.has(lease.mac)) byMac.set(lease.mac, lease);
    }

    return { byIp, byMac };
}

async function syncHotspotUsers(routerId, routerUsers) {
    if (!routerUsers.length) {
        return;
    }

    const operations = routerUsers.map((record) => ({
        updateOne: {
            filter: { routerId, username: record.name },
            update: {
                $set: {
                    profile: record.profile || 'default',
                    comment: record.comment || '',
                    dataLimitBytes: toNumber(record['limit-bytes-total']),
                    timeLimitSeconds: parseDurationToSeconds(record['limit-uptime']),
                    isActive: !['yes', 'true'].includes(String(record.disabled || '').toLowerCase()),
                    bytesIn: toNumber(record['bytes-in']),
                    bytesOut: toNumber(record['bytes-out']),
                    routerosId: record['.id'] || '',
                    expiresAt: null
                },
                $setOnInsert: {
                    createdBy: 'router-sync'
                }
            },
            upsert: true
        }
    }));

    await HotspotUser.bulkWrite(operations, { ordered: false });
}

async function syncActiveSessions(routerId, activeSessions, dhcpLeases = { byIp: new Map(), byMac: new Map() }) {
    const usernames = [...new Set(activeSessions.map((item) => item.user).filter(Boolean))];
    const users = usernames.length
        ? await HotspotUser.find({ routerId, username: { $in: usernames } }).select('_id username profile')
        : [];
    const usersByUsername = new Map(users.map((user) => [user.username, user]));
    const sessionIds = activeSessions.map((item) => item['.id']).filter(Boolean);
    const existingSessions = sessionIds.length
        ? await HotspotSession.find({ routerId, sessionId: { $in: sessionIds } }).select('sessionId uplinkBytes downlinkBytes updatedAt')
        : [];
    const existingBySessionId = new Map(existingSessions.map((session) => [session.sessionId, session]));

    if (sessionIds.length) {
        const operations = activeSessions.map((record) => {
            const sessionId = record['.id'];
            const ip = record.address || '';
            const mac = String(record['mac-address'] || '').toUpperCase();
            const lease = dhcpLeases.byIp.get(ip) || dhcpLeases.byMac.get(mac) || null;
            const uplinkBytes = toNumber(record['bytes-out']);
            const downlinkBytes = toNumber(record['bytes-in']);
            const previous = existingBySessionId.get(sessionId);
            const elapsedSeconds = previous?.updatedAt ? Math.max(1, Math.round((Date.now() - new Date(previous.updatedAt).getTime()) / 1000)) : 0;
            const currentUplinkBps = elapsedSeconds && previous ? Math.max(0, Math.round((uplinkBytes - (previous.uplinkBytes || 0)) / elapsedSeconds)) : 0;
            const currentDownlinkBps = elapsedSeconds && previous ? Math.max(0, Math.round((downlinkBytes - (previous.downlinkBytes || 0)) / elapsedSeconds)) : 0;
            const hostName = record['host-name'] || lease?.hostName || '';
            const deviceLabel = hostName || lease?.comment || record['caller-id'] || record['mac-address'] || record.address || '';

            return {
                updateOne: {
                    filter: { routerId, sessionId },
                    update: {
                        $set: {
                            hotspotUserId: usersByUsername.get(record.user)?._id || null,
                            username: record.user || '',
                            ip,
                            mac: record['mac-address'] || '',
                            uplinkBytes,
                            downlinkBytes,
                            currentUplinkBps,
                            currentDownlinkBps,
                            uptimeSeconds: parseDurationToSeconds(record.uptime),
                            sessionTimeLeftSeconds: parseDurationToSeconds(record['session-time-left']),
                            idleTimeoutSeconds: parseDurationToSeconds(record['idle-timeout']),
                            keepaliveTimeoutSeconds: parseDurationToSeconds(record['keepalive-timeout']),
                            server: record.server || record['server'] || 'default',
                            hostName,
                            deviceLabel,
                            profile: record.profile || usersByUsername.get(record.user)?.profile || 'default',
                            isActive: true,
                            endedAt: null
                        },
                        $setOnInsert: {
                            startedAt: toDateOrNull(record['login-time']) || new Date(Date.now() - (parseDurationToSeconds(record.uptime) * 1000))
                        }
                    },
                    upsert: true
                }
            };
        });

        await HotspotSession.bulkWrite(operations, { ordered: false });
    }

    await HotspotSession.updateMany(
        {
            routerId,
            isActive: true,
            ...(sessionIds.length ? { sessionId: { $nin: sessionIds } } : {})
        },
        {
            $set: {
                isActive: false,
                endedAt: new Date()
            }
        }
    );
}

async function listHotspotUsers(routerId, page = 1, limit = 50, search = '') {
    await ensureRouterExists(routerId);
    const [routerUsers, activeSessionRecords, dhcpLeases] = await Promise.all([
        executeCommand(routerId, '/ip/hotspot/user/print', {}, { operationName: 'get_system_resource' }),
        executeCommand(routerId, '/ip/hotspot/active/print', {}, { operationName: 'get_system_resource' }).catch(() => []),
        fetchDhcpLeases(routerId)
    ]);
    await syncHotspotUsers(routerId, routerUsers);
    await syncActiveSessions(routerId, activeSessionRecords, dhcpLeases);

    const activeSessions = await HotspotSession.find({ routerId, isActive: true }).select('username');
    const activeUsernames = new Set(activeSessions.map((session) => session.username).filter(Boolean));
    const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : null;
    const filter = {
        routerId,
        ...(searchRegex ? { $or: [{ username: searchRegex }, { comment: searchRegex }] } : {})
    };

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const total = await HotspotUser.countDocuments(filter);
    const items = await HotspotUser.find(filter)
        .sort({ createdAt: -1, username: 1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit);

    return {
        items: items.map((item) => serializeHotspotUser(item, activeUsernames)),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.max(1, Math.ceil(total / safeLimit))
        }
    };
}

async function getHotspotUserDetail(routerId, userId) {
    const user = await HotspotUser.findOne({ _id: userId, routerId });
    if (!user) {
        throw new Error('Hotspot user not found');
    }

    const sessions = await HotspotSession.find({
        routerId,
        $or: [
            { hotspotUserId: user._id },
            { username: user.username }
        ]
    })
        .sort({ createdAt: -1 })
        .limit(10);

    return {
        ...serializeHotspotUser(user),
        recentSessions: sessions.map(serializeHotspotSession)
    };
}

async function createHotspotUser(routerId, payload) {
    await ensureRouterExists(routerId);
    const {
        username,
        password,
        profile = 'default',
        dataLimitBytes = 0,
        timeLimitSeconds = 0,
        expiresAt = null,
        comment = ''
    } = payload;

    const attributes = {
        name: username,
        password,
        profile,
        comment
    };
    if (Number(dataLimitBytes) > 0) {
        attributes['limit-bytes-total'] = String(Math.floor(Number(dataLimitBytes)));
    }
    if (Number(timeLimitSeconds) > 0) {
        attributes['limit-uptime'] = formatDuration(timeLimitSeconds);
    }

    await executeCommand(routerId, '/ip/hotspot/user/add', attributes, { operationName: 'hotspot_mutation', scope: 'hotspot' });
    const routerRecord = await fetchRouterHotspotUserRecord(routerId, username);
    const hashedPassword = password ? await bcrypt.hash(password, 10) : '';

    const user = await HotspotUser.findOneAndUpdate(
        { routerId, username },
        {
            $set: {
                password: hashedPassword,
                profile,
                comment,
                dataLimitBytes: Number(dataLimitBytes) || 0,
                timeLimitSeconds: Number(timeLimitSeconds) || 0,
                expiresAt: toDateOrNull(expiresAt),
                isActive: true,
                routerosId: routerRecord?.['.id'] || ''
            },
            $setOnInsert: {
                createdBy: 'admin'
            }
        },
        { new: true, upsert: true }
    );

    return serializeHotspotUser(user);
}

async function updateHotspotUser(routerId, routerosId, updates) {
    await ensureRouterExists(routerId);
    const routerUser = await HotspotUser.findOne({ routerId, routerosId });
    if (!routerUser) {
        throw new Error('Hotspot user not found');
    }

    const commandAttributes = { '.id': routerosId };
    const databaseUpdates = {};

    if (updates.username) {
        commandAttributes.name = updates.username;
        databaseUpdates.username = updates.username;
    }
    if (updates.password) {
        commandAttributes.password = updates.password;
        databaseUpdates.password = await bcrypt.hash(updates.password, 10);
    }
    if (updates.profile != null) {
        commandAttributes.profile = updates.profile || 'default';
        databaseUpdates.profile = updates.profile || 'default';
    }
    if (updates.comment != null) {
        commandAttributes.comment = updates.comment || '';
        databaseUpdates.comment = updates.comment || '';
    }
    if (updates.dataLimitBytes != null) {
        commandAttributes['limit-bytes-total'] = Number(updates.dataLimitBytes) > 0 ? String(Math.floor(Number(updates.dataLimitBytes))) : '0';
        databaseUpdates.dataLimitBytes = Number(updates.dataLimitBytes) || 0;
    }
    if (updates.timeLimitSeconds != null) {
        commandAttributes['limit-uptime'] = Number(updates.timeLimitSeconds) > 0 ? formatDuration(updates.timeLimitSeconds) : '0s';
        databaseUpdates.timeLimitSeconds = Number(updates.timeLimitSeconds) || 0;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'isActive')) {
        commandAttributes.disabled = updates.isActive ? 'no' : 'yes';
        databaseUpdates.isActive = Boolean(updates.isActive);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'expiresAt')) {
        databaseUpdates.expiresAt = toDateOrNull(updates.expiresAt);
    }

    await executeCommand(routerId, '/ip/hotspot/user/set', commandAttributes, { operationName: 'hotspot_mutation', scope: 'hotspot' });
    const user = await HotspotUser.findOneAndUpdate(
        { routerId, routerosId },
        { $set: databaseUpdates },
        { new: true }
    );

    return serializeHotspotUser(user);
}

async function deleteHotspotUser(routerId, routerosId, userId) {
    await ensureRouterExists(routerId);
    await executeCommand(routerId, '/ip/hotspot/user/remove', { '.id': routerosId }, { operationName: 'hotspot_mutation', scope: 'hotspot' });
    await HotspotUser.findOneAndUpdate(
        { _id: userId, routerId },
        {
            $set: {
                isActive: false
            }
        }
    );
    return { message: 'Hotspot user deleted' };
}

async function listActiveSessions(routerId) {
    await ensureRouterExists(routerId);
    const [records, dhcpLeases] = await Promise.all([
        executeCommand(routerId, '/ip/hotspot/active/print', {}, { operationName: 'get_system_resource' }),
        fetchDhcpLeases(routerId)
    ]);
    await syncActiveSessions(routerId, records, dhcpLeases);
    const sessions = await HotspotSession.find({ routerId, isActive: true }).sort({ createdAt: -1 });
    return sessions.map(serializeHotspotSession);
}

async function disconnectSession(routerId, sessionId) {
    await ensureRouterExists(routerId);
    await executeCommand(routerId, '/ip/hotspot/active/remove', { '.id': sessionId }, { operationName: 'safe_operational', scope: 'hotspot' });
    await HotspotSession.findOneAndUpdate(
        { routerId, sessionId },
        {
            $set: {
                isActive: false,
                endedAt: new Date()
            }
        }
    );
    return { message: 'Hotspot session disconnected' };
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = [];
    let currentIndex = 0;

    async function consume() {
        while (currentIndex < items.length) {
            const index = currentIndex;
            currentIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => consume());
    await Promise.all(workers);
    return results;
}

function generateRandomCredential(prefix = 'HS') {
    const normalizedPrefix = String(prefix || 'HS').replace(/[^a-z0-9_-]/gi, '').slice(0, 8) || 'HS';
    const suffix = crypto.randomBytes(3).toString('hex');
    const password = crypto.randomBytes(4).toString('base64url').slice(0, 8);
    return {
        username: `${normalizedPrefix}-${suffix}`,
        password
    };
}

async function generateVouchers(routerId, payload) {
    const count = Math.min(100, Math.max(1, Number(payload.count) || 1));
    const baseUsers = Array.from({ length: count }, () => generateRandomCredential(payload.prefix));
    const batchId = `router-${routerId}-${Date.now()}`;

    const vouchers = await runWithConcurrency(baseUsers, 10, async (item) => {
        const user = await createHotspotUser(routerId, {
            username: item.username,
            password: item.password,
            profile: payload.profile || 'default',
            dataLimitBytes: payload.dataLimitBytes || 0,
            timeLimitSeconds: payload.timeLimitSeconds || 0,
            expiresAt: payload.expiresAt || null,
            comment: payload.comment || `Voucher batch ${new Date().toISOString()}`
        });
        await HotspotVoucher.findOneAndUpdate(
            { routerId, username: item.username },
            {
                $set: {
                    hotspotUserId: user.id,
                    password: item.password,
                    profile: payload.profile || 'default',
                    dataLimitBytes: payload.dataLimitBytes || 0,
                    timeLimitSeconds: payload.timeLimitSeconds || 0,
                    comment: payload.comment || `Voucher batch ${new Date().toISOString()}`,
                    batchId,
                    status: 'unused',
                    expiresAt: toDateOrNull(payload.expiresAt),
                    usedAt: null,
                    revokedAt: null,
                    createdBy: payload.createdBy || 'admin'
                }
            },
            { new: true, upsert: true }
        );
        return item;
    });

    return vouchers;
}

async function listVouchers(routerId, { status = '', page = 1, limit = 50 } = {}) {
    await ensureRouterExists(routerId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const query = { routerId };

    if (status && ['unused', 'used', 'expired', 'revoked'].includes(String(status))) {
        if (status === 'expired') {
            query.status = 'unused';
            query.expiresAt = { $lt: new Date() };
        } else {
            query.status = String(status);
        }
    }

    const [items, total] = await Promise.all([
        HotspotVoucher.find(query)
            .sort({ createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit),
        HotspotVoucher.countDocuments(query)
    ]);

    return {
        items: items.map(serializeVoucher),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.max(1, Math.ceil(total / safeLimit))
        }
    };
}

async function revokeVoucher(routerId, voucherId) {
    await ensureRouterExists(routerId);
    const voucher = await HotspotVoucher.findOne({ _id: voucherId, routerId });
    if (!voucher) {
        throw new Error('Voucher not found');
    }
    if (voucher.status === 'used') {
        const error = new Error('Used vouchers cannot be revoked');
        error.statusCode = 409;
        throw error;
    }

    voucher.status = 'revoked';
    voucher.revokedAt = new Date();
    await voucher.save();

    const hotspotUser = await HotspotUser.findOne({
        routerId,
        $or: [
            { _id: voucher.hotspotUserId || null },
            { username: voucher.username }
        ]
    });

    if (hotspotUser?.routerosId) {
        await executeCommand(routerId, '/ip/hotspot/user/set', {
            '.id': hotspotUser.routerosId,
            disabled: 'yes'
        }, { operationName: 'hotspot_mutation', scope: 'hotspot' }).catch(() => {});
    }

    if (hotspotUser) {
        hotspotUser.isActive = false;
        await hotspotUser.save();
    }

    return { message: 'Voucher revoked' };
}

async function listProfiles(routerId) {
    await ensureRouterExists(routerId);
    const records = await executeCommand(routerId, '/ip/hotspot/user/profile/print', {}, { operationName: 'get_system_resource' });
    return records.map(serializeHotspotProfile);
}

module.exports = {
    listHotspotUsers,
    getHotspotUserDetail,
    createHotspotUser,
    updateHotspotUser,
    deleteHotspotUser,
    listActiveSessions,
    disconnectSession,
    generateVouchers,
    listProfiles,
    listVouchers,
    revokeVoucher
};
