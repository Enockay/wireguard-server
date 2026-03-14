const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const VpnServer = require('../models/VpnServer');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const AdminAuditLog = require('../models/AdminAuditLog');
const MonitoringIncident = require('../models/MonitoringIncident');
const SecurityEvent = require('../models/SecurityEvent');
const UserSession = require('../models/UserSession');
const { recordAdminAction } = require('./admin-audit-service');
const { recordSecurityEvent, revokeSession, revokeAllUserSessions } = require('./security-event-service');

const ADMIN_LOG_PERMISSIONS = {
    VIEW_LOGS: 'admin.logs.view',
    SEARCH_LOGS: 'admin.logs.search',
    VIEW_AUDIT: 'admin.audit.view',
    VIEW_SECURITY: 'admin.security.view',
    VIEW_SESSIONS: 'admin.security.view_sessions',
    MANAGE_SESSIONS: 'admin.security.manage_sessions',
    VIEW_USER_SECURITY: 'admin.security.view_user_security',
    REVIEW_SECURITY: 'admin.security.review',
    FLAG_SECURITY: 'admin.security.flag',
    RESOLVE_SECURITY: 'admin.security.resolve',
    EXPORT_AUDIT: 'admin.audit.export'
};

const SECURITY_REVIEW_NOTE_CATEGORIES = ['review', 'investigation', 'resolution', 'follow_up'];

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function paginate(items, page = 1, limit = 20) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const total = items.length;
    const start = (safePage - 1) * safeLimit;
    return {
        items: items.slice(start, start + safeLimit),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 1
        }
    };
}

function summarizeActor(source, actorUser) {
    if (actorUser) {
        return {
            type: actorUser.role === 'admin' ? 'admin' : 'user',
            id: String(actorUser._id),
            name: actorUser.name,
            email: actorUser.email
        };
    }
    return {
        type: source || 'system',
        id: null,
        name: source === 'system' ? 'System' : null,
        email: null
    };
}

function normalizeAuditItem(entry) {
    let resourceType = 'platform';
    let resourceId = null;
    if (entry.targetRouterId) {
        resourceType = 'router';
        resourceId = String(entry.targetRouterId._id || entry.targetRouterId);
    } else if (entry.targetServerId) {
        resourceType = 'vpn_server';
        resourceId = String(entry.targetServerId._id || entry.targetServerId);
    } else if (entry.targetIncidentId) {
        resourceType = 'incident';
        resourceId = String(entry.targetIncidentId._id || entry.targetIncidentId);
    } else if (entry.targetTicketId) {
        resourceType = 'support_ticket';
        resourceId = String(entry.targetTicketId._id || entry.targetTicketId);
    } else if (entry.targetSecurityEventId) {
        resourceType = 'security_event';
        resourceId = String(entry.targetSecurityEventId._id || entry.targetSecurityEventId);
    } else if (entry.targetSessionId) {
        resourceType = 'session';
        resourceId = entry.targetSessionId;
    } else if (entry.targetUserId) {
        resourceType = 'user';
        resourceId = String(entry.targetUserId._id || entry.targetUserId);
    }

    return {
        id: `audit:${entry._id}`,
        auditId: String(entry._id),
        actionType: entry.action,
        actor: summarizeActor('admin', entry.actorUserId),
        resourceType,
        resourceId,
        targetAccount: entry.targetUserId ? {
            id: String(entry.targetUserId._id || entry.targetUserId),
            name: entry.targetUserId.name || null,
            email: entry.targetUserId.email || null
        } : null,
        reason: entry.reason || '',
        metadata: entry.metadata || {},
        ipAddress: entry.ipAddress || '',
        userAgent: entry.userAgent || '',
        timestamp: entry.createdAt
    };
}

function normalizeSecurityEvent(event, user = null) {
    return {
        id: `security:${event._id}`,
        eventId: String(event._id),
        eventType: event.eventType,
        category: event.category,
        severity: event.severity,
        source: event.source,
        success: event.success !== false,
        user: user ? {
            id: String(user._id),
            name: user.name,
            email: user.email
        } : (event.userId ? {
            id: String(event.userId._id || event.userId),
            name: event.userId.name || null,
            email: event.userId.email || null
        } : null),
        actor: event.actorUserId ? {
            id: String(event.actorUserId._id || event.actorUserId),
            name: event.actorUserId.name || null,
            email: event.actorUserId.email || null
        } : null,
        sessionId: event.sessionId || null,
        ipAddress: event.ipAddress || '',
        userAgent: event.userAgent || '',
        reason: event.reason || '',
        metadata: event.metadata || {},
        acknowledgedAt: event.acknowledgedAt || null,
        resolvedAt: event.resolvedAt || null,
        reviewedAt: event.reviewedAt || null,
        notes: (event.notes || []).map((note) => ({
            id: String(note._id),
            body: note.body,
            category: note.category || 'review',
            author: note.author || 'system',
            createdAt: note.createdAt
        })),
        timestamp: event.createdAt
    };
}

function normalizeSession(session, user = null) {
    return {
        id: session.sessionId,
        sessionId: session.sessionId,
        user: user ? {
            id: String(user._id),
            name: user.name,
            email: user.email
        } : (session.userId ? {
            id: String(session.userId._id || session.userId),
            name: session.userId.name || null,
            email: session.userId.email || null
        } : null),
        source: session.source,
        ipAddress: session.ipAddress || '',
        userAgent: session.userAgent || '',
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt || null,
        revokedAt: session.revokedAt || null,
        revokedBy: session.revokedBy || null,
        revokeReason: session.revokeReason || '',
        status: session.status
    };
}

async function loadCoreLogData() {
    const [users, routers, servers, subscriptions, transactions, tickets, audits, incidents, securityEvents, sessions] = await Promise.all([
        User.find({}).lean(),
        MikrotikRouter.find({}).lean(),
        VpnServer.find({}).lean(),
        Subscription.find({}).lean(),
        Transaction.find({}).lean(),
        SupportTicket.find({}).lean(),
        AdminAuditLog.find({})
            .populate('actorUserId', 'name email role')
            .populate('targetUserId', 'name email')
            .sort({ createdAt: -1 })
            .lean(),
        MonitoringIncident.find({}).populate('relatedUserId', 'name email').sort({ createdAt: -1 }).lean(),
        SecurityEvent.find({})
            .populate('userId', 'name email role failedLoginCount lastLoginAt lastFailedLoginAt lastSecurityReviewAt')
            .populate('actorUserId', 'name email role')
            .sort({ createdAt: -1 })
            .lean(),
        UserSession.find({}).populate('userId', 'name email role').sort({ createdAt: -1 }).lean()
    ]);

    return {
        users,
        usersById: new Map(users.map((item) => [String(item._id), item])),
        routersById: new Map(routers.map((item) => [String(item._id), item])),
        serversById: new Map(servers.map((item) => [String(item._id), item])),
        subscriptionsById: new Map(subscriptions.map((item) => [String(item._id), item])),
        ticketsById: new Map(tickets.map((item) => [String(item._id), item])),
        audits,
        incidents,
        securityEvents,
        sessions,
        transactions,
        subscriptions,
        tickets
    };
}

function buildGlobalActivityItems(bundle) {
    const items = [];

    bundle.audits.forEach((audit) => {
        const normalized = normalizeAuditItem(audit);
        items.push({
            eventId: normalized.id,
            eventType: normalized.actionType,
            category: 'admin_audit',
            actor: normalized.actor,
            source: 'admin',
            resourceType: normalized.resourceType,
            resourceId: normalized.resourceId,
            targetUser: normalized.targetAccount,
            summary: normalized.reason || normalized.actionType,
            metadataPreview: normalized.metadata,
            severity: 'info',
            timestamp: normalized.timestamp
        });
    });

    bundle.securityEvents.forEach((event) => {
        const normalized = normalizeSecurityEvent(event);
        items.push({
            eventId: normalized.id,
            eventType: normalized.eventType,
            category: 'security',
            actor: normalized.actor || normalized.user || summarizeActor(normalized.source, null),
            source: normalized.source,
            resourceType: normalized.sessionId ? 'session' : 'user',
            resourceId: normalized.sessionId || normalized.user?.id || null,
            targetUser: normalized.user,
            summary: normalized.reason || normalized.eventType,
            metadataPreview: normalized.metadata,
            severity: normalized.severity,
            timestamp: normalized.timestamp
        });
    });

    bundle.incidents.forEach((incident) => {
        items.push({
            eventId: `incident:${incident._id}`,
            eventType: incident.type,
            category: 'incident',
            actor: summarizeActor(incident.source, null),
            source: incident.source,
            resourceType: incident.relatedRouterId ? 'router' : (incident.relatedServerId ? 'vpn_server' : 'incident'),
            resourceId: incident.relatedRouterId ? String(incident.relatedRouterId) : (incident.relatedServerId ? String(incident.relatedServerId) : String(incident._id)),
            targetUser: incident.relatedUserId ? {
                id: String(incident.relatedUserId._id || incident.relatedUserId),
                name: incident.relatedUserId.name || null,
                email: incident.relatedUserId.email || null
            } : null,
            summary: incident.title,
            metadataPreview: incident.metadata || {},
            severity: incident.severity,
            timestamp: incident.updatedAt || incident.createdAt
        });
    });

    bundle.subscriptions.forEach((subscription) => {
        items.push({
            eventId: `subscription:${subscription._id}`,
            eventType: 'subscription_event',
            category: 'billing',
            actor: summarizeActor('system', null),
            source: 'system',
            resourceType: 'subscription',
            resourceId: String(subscription._id),
            targetUser: bundle.usersById.get(String(subscription.userId)) ? {
                id: String(subscription.userId),
                name: bundle.usersById.get(String(subscription.userId)).name,
                email: bundle.usersById.get(String(subscription.userId)).email
            } : null,
            summary: `Subscription ${subscription.status}`,
            metadataPreview: { planType: subscription.planType, pricePerMonth: subscription.pricePerMonth },
            severity: subscription.status === 'past_due' ? 'high' : 'info',
            timestamp: subscription.updatedAt || subscription.createdAt
        });
    });

    bundle.transactions.forEach((transaction) => {
        items.push({
            eventId: `transaction:${transaction._id}`,
            eventType: transaction.status === 'failed' ? 'payment_failed' : `${transaction.type}_event`,
            category: 'billing',
            actor: summarizeActor('system', null),
            source: 'system',
            resourceType: transaction.type,
            resourceId: String(transaction._id),
            targetUser: bundle.usersById.get(String(transaction.userId)) ? {
                id: String(transaction.userId),
                name: bundle.usersById.get(String(transaction.userId)).name,
                email: bundle.usersById.get(String(transaction.userId)).email
            } : null,
            summary: transaction.description,
            metadataPreview: { amount: transaction.amount, status: transaction.status, transactionId: transaction.transactionId },
            severity: transaction.status === 'failed' ? 'high' : 'info',
            timestamp: transaction.settledAt || transaction.createdAt
        });
    });

    bundle.tickets.forEach((ticket) => {
        items.push({
            eventId: `ticket:${ticket._id}`,
            eventType: 'support_ticket_event',
            category: 'support',
            actor: summarizeActor('user', null),
            source: 'user',
            resourceType: 'support_ticket',
            resourceId: String(ticket._id),
            targetUser: bundle.usersById.get(String(ticket.userId)) ? {
                id: String(ticket.userId),
                name: bundle.usersById.get(String(ticket.userId)).name,
                email: bundle.usersById.get(String(ticket.userId)).email
            } : null,
            summary: `Support ticket ${ticket.status}: ${ticket.subject}`,
            metadataPreview: { priority: ticket.priority, category: ticket.category },
            severity: ticket.priority === 'urgent' ? 'high' : 'info',
            timestamp: ticket.updatedAt || ticket.createdAt
        });
    });

    return items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
}

async function listGlobalActivity(query = {}) {
    const bundle = await loadCoreLogData();
    let items = buildGlobalActivityItems(bundle);
    const q = String(query.q || '').trim().toLowerCase();
    const from = toDateOrNull(query.from);
    const to = toDateOrNull(query.to);

    items = items.filter((item) => {
        if (q) {
            const haystack = [
                item.eventType,
                item.category,
                item.resourceType,
                item.resourceId,
                item.summary,
                item.actor?.name,
                item.actor?.email,
                item.targetUser?.name,
                item.targetUser?.email
            ].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.eventType && item.eventType !== query.eventType) return false;
        if (query.resourceType && item.resourceType !== query.resourceType) return false;
        if (query.actorType && item.actor?.type !== query.actorType) return false;
        if (query.severity && item.severity !== query.severity) return false;
        const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
        if (from && ts < from.getTime()) return false;
        if (to && ts > to.getTime()) return false;
        return true;
    });

    return paginate(items, query.page, query.limit);
}

async function getGlobalActivityEvent(eventId) {
    const [prefix, rawId] = String(eventId || '').split(':');
    if (!prefix || !rawId) return null;
    if (prefix === 'audit') {
        const entry = await AdminAuditLog.findById(rawId).populate('actorUserId', 'name email role').populate('targetUserId', 'name email').lean();
        return entry ? normalizeAuditItem(entry) : null;
    }
    if (prefix === 'security') {
        const event = await SecurityEvent.findById(rawId).populate('userId', 'name email').populate('actorUserId', 'name email').lean();
        return event ? normalizeSecurityEvent(event) : null;
    }
    if (prefix === 'incident') {
        const incident = await MonitoringIncident.findById(rawId).populate('relatedUserId', 'name email').lean();
        return incident ? {
            id: `incident:${incident._id}`,
            type: incident.type,
            category: 'incident',
            summary: incident.title,
            severity: incident.severity,
            status: incident.status,
            metadata: incident.metadata || {},
            timestamp: incident.updatedAt || incident.createdAt
        } : null;
    }
    if (prefix === 'transaction') {
        const transaction = await Transaction.findById(rawId).lean();
        return transaction ? {
            id: `transaction:${transaction._id}`,
            type: transaction.type,
            category: 'billing',
            summary: transaction.description,
            status: transaction.status,
            metadata: { transactionId: transaction.transactionId, amount: transaction.amount },
            timestamp: transaction.settledAt || transaction.createdAt
        } : null;
    }
    if (prefix === 'ticket') {
        const ticket = await SupportTicket.findById(rawId).lean();
        return ticket ? {
            id: `ticket:${ticket._id}`,
            type: 'support_ticket_event',
            category: 'support',
            summary: ticket.subject,
            status: ticket.status,
            metadata: { priority: ticket.priority, category: ticket.category },
            timestamp: ticket.updatedAt || ticket.createdAt
        } : null;
    }
    return null;
}

async function listAuditTrail(query = {}) {
    let entries = await AdminAuditLog.find({})
        .populate('actorUserId', 'name email role')
        .populate('targetUserId', 'name email')
        .sort({ createdAt: -1 })
        .lean();
    const q = String(query.q || '').trim().toLowerCase();
    const from = toDateOrNull(query.from);
    const to = toDateOrNull(query.to);
    const items = entries.map(normalizeAuditItem).filter((item) => {
        if (q) {
            const haystack = [item.actionType, item.actor?.name, item.actor?.email, item.resourceType, item.resourceId, item.reason, item.targetAccount?.email].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.actionType && item.actionType !== query.actionType) return false;
        if (query.resourceType && item.resourceType !== query.resourceType) return false;
        if (query.actorAdmin && item.actor?.email !== query.actorAdmin) return false;
        if (query.targetUserId && item.targetAccount?.id !== query.targetUserId) return false;
        const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
        if (from && ts < from.getTime()) return false;
        if (to && ts > to.getTime()) return false;
        return true;
    });
    return paginate(items, query.page, query.limit);
}

async function getAuditDetail(auditId) {
    const entry = await AdminAuditLog.findById(auditId)
        .populate('actorUserId', 'name email role')
        .populate('targetUserId', 'name email')
        .lean();
    return entry ? normalizeAuditItem(entry) : null;
}

async function getSecurityOverview() {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const [events, sessions, users, audits] = await Promise.all([
        SecurityEvent.find({ createdAt: { $gte: new Date(since) } }).lean(),
        UserSession.find({}).lean(),
        User.find({}).lean(),
        AdminAuditLog.find({ action: /security|force_logout|send_password_reset/ }).lean()
    ]);
    return {
        totalSuccessfulLogins: events.filter((event) => event.eventType === 'login_succeeded').length,
        totalFailedLogins: events.filter((event) => event.eventType === 'login_failed').length,
        suspiciousLoginAttempts: events.filter((event) => event.eventType === 'login_failed' && event.severity === 'high').length,
        lockedAccountsCount: 0,
        accountsUnderReview: users.filter((user) => user.lastSecurityReviewAt).length,
        activeSessionsCount: sessions.filter((session) => session.status === 'active').length,
        recentlyRevokedSessionsCount: sessions.filter((session) => session.revokedAt && new Date(session.revokedAt).getTime() >= since).length,
        passwordResetRequests: events.filter((event) => event.eventType === 'password_reset_requested').length,
        passwordResetCompletions: events.filter((event) => event.eventType === 'password_reset_completed').length,
        emailVerificationEvents: events.filter((event) => ['email_verified', 'verification_email_sent'].includes(event.eventType)).length,
        adminSecuritySensitiveActions: audits.length,
        unresolvedSecurityFlags: (await SecurityEvent.countDocuments({ severity: { $in: ['high', 'critical'] }, resolvedAt: { $exists: false } })),
        usersWithRepeatedFailures: users.filter((user) => (user.failedLoginCount || 0) >= 3).length,
        latestSecurityCheckAt: new Date().toISOString()
    };
}

async function listSecurityEvents(query = {}) {
    let events = await SecurityEvent.find({})
        .populate('userId', 'name email role failedLoginCount lastLoginAt lastFailedLoginAt lastSecurityReviewAt')
        .populate('actorUserId', 'name email role')
        .sort({ createdAt: -1 })
        .lean();
    const q = String(query.q || '').trim().toLowerCase();
    const from = toDateOrNull(query.from);
    const to = toDateOrNull(query.to);
    const items = events.map(normalizeSecurityEvent).filter((item) => {
        if (q) {
            const haystack = [item.eventType, item.category, item.user?.name, item.user?.email, item.ipAddress, item.userAgent, item.reason].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.userId && item.user?.id !== query.userId) return false;
        if (query.email && item.user?.email !== query.email) return false;
        if (query.ip && item.ipAddress !== query.ip) return false;
        if (query.eventType && item.eventType !== query.eventType) return false;
        if (query.source && item.source !== query.source) return false;
        if (query.suspiciousOnly === 'true' && !['high', 'critical'].includes(item.severity)) return false;
        const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
        if (from && ts < from.getTime()) return false;
        if (to && ts > to.getTime()) return false;
        return true;
    });
    return paginate(items, query.page, query.limit);
}

async function getSecurityEventDetail(eventId) {
    const event = await SecurityEvent.findById(eventId).populate('userId', 'name email').populate('actorUserId', 'name email').lean();
    return event ? normalizeSecurityEvent(event) : null;
}

async function listSuspiciousActivity(query = {}) {
    const [events, users] = await Promise.all([
        listSecurityEvents({ ...query, suspiciousOnly: 'true', page: 1, limit: 1000 }),
        User.find({}).lean()
    ]);
    const repeatedFailures = users.filter((user) => (user.failedLoginCount || 0) >= 3).map((user) => ({
        type: 'repeated_failed_logins',
        user: { id: String(user._id), name: user.name, email: user.email },
        severity: (user.failedLoginCount || 0) >= 5 ? 'high' : 'medium',
        summary: `User has ${user.failedLoginCount} failed login attempts recorded.`,
        timestamp: user.lastFailedLoginAt || user.updatedAt
    }));
    const items = events.items.concat(repeatedFailures).sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function listSecurityReviews(query = {}) {
    const events = await SecurityEvent.find({
        $or: [
            { severity: { $in: ['high', 'critical'] } },
            { reviewedAt: { $exists: true } },
            { acknowledgedAt: { $exists: true } }
        ]
    }).populate('userId', 'name email').sort({ createdAt: -1 }).lean();
    const items = events.map(normalizeSecurityEvent).filter((item) => {
        if (query.status === 'reviewed' && !item.reviewedAt) return false;
        if (query.status === 'pending' && item.reviewedAt) return false;
        return true;
    });
    return paginate(items, query.page, query.limit);
}

async function listSessions(query = {}) {
    const sessions = await UserSession.find({})
        .populate('userId', 'name email role')
        .sort({ issuedAt: -1 })
        .lean();
    let items = sessions.map((session) => normalizeSession(session));
    if (query.userId) items = items.filter((item) => item.user?.id === query.userId);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.ip) items = items.filter((item) => item.ipAddress === query.ip);
    return paginate(items, query.page, query.limit);
}

async function listUserSessions(userId, query = {}) {
    const user = await User.findById(userId).lean();
    if (!user) return null;
    const sessions = await UserSession.find({ userId }).sort({ issuedAt: -1 }).lean();
    return paginate(sessions.map((session) => normalizeSession(session, user)), query.page, query.limit);
}

async function revokeSingleSession(sessionId, adminUser, reason, req) {
    const session = await revokeSession(sessionId, adminUser.email, reason, adminUser._id);
    if (!session) return null;
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: session.userId,
        targetSessionId: session.sessionId,
        action: 'admin.security.revoke_session',
        reason,
        metadata: { revokedAt: session.revokedAt }
    });
    return session;
}

async function revokeAllSessionsForUser(userId, adminUser, reason, req) {
    const user = await User.findById(userId);
    if (!user) return null;
    user.sessionsRevokedAt = new Date();
    await user.save();
    const revoked = await revokeAllUserSessions(userId, adminUser.email, reason, adminUser._id);
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: userId,
        action: 'admin.security.revoke_all_sessions',
        reason,
        metadata: { revokedCount: revoked.length, sessionsRevokedAt: user.sessionsRevokedAt }
    });
    return { user, revokedCount: revoked.length };
}

async function getUserSecuritySummary(userId) {
    const [user, events, sessions, audits] = await Promise.all([
        User.findById(userId).lean(),
        SecurityEvent.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
        UserSession.find({ userId }).sort({ issuedAt: -1 }).lean(),
        AdminAuditLog.find({ targetUserId: userId }).populate('actorUserId', 'name email role').sort({ createdAt: -1 }).limit(50).lean()
    ]);
    if (!user) return null;
    return {
        user: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            accountStatus: user.isActive ? 'active' : 'suspended'
        },
        lastSuccessfulLogin: user.lastLoginAt || null,
        lastFailedLogin: user.lastFailedLoginAt || null,
        repeatedFailedLoginCount: user.failedLoginCount || 0,
        passwordResetRequests: events.filter((event) => event.eventType === 'password_reset_requested').length,
        passwordResetCompletions: events.filter((event) => event.eventType === 'password_reset_completed').length,
        verificationEvents: events.filter((event) => ['email_verified', 'verification_email_sent'].includes(event.eventType)).length,
        activeSessionsCount: sessions.filter((session) => session.status === 'active').length,
        revokedSessionsCount: sessions.filter((session) => session.status === 'revoked').length,
        suspiciousFlags: (user.internalFlags || []).filter((flag) => ['suspicious', 'watchlist'].includes(flag.flag)),
        recentSecurityAdminActions: audits.map(normalizeAuditItem).slice(0, 20),
        reviewStatus: user.lastSecurityReviewAt ? 'reviewed' : 'pending'
    };
}

async function getUserSecurityEvents(userId, query = {}) {
    const user = await User.findById(userId).lean();
    if (!user) return null;
    return listSecurityEvents({ ...query, userId });
}

async function getUserSecurityReviews(userId, query = {}) {
    const user = await User.findById(userId).lean();
    if (!user) return null;
    const events = await SecurityEvent.find({ userId, $or: [{ reviewedAt: { $exists: true } }, { severity: { $in: ['high', 'critical'] } }] }).sort({ createdAt: -1 }).lean();
    return paginate(events.map(normalizeSecurityEvent), query.page, query.limit);
}

async function markUserSecurityReviewed(userId, adminUser, reason, req) {
    const user = await User.findById(userId);
    if (!user) return null;
    user.lastSecurityReviewAt = new Date();
    user.adminNotes.push({
        body: `Security reviewed. ${reason}`.trim(),
        category: 'security',
        author: adminUser.email
    });
    await user.save();
    await recordSecurityEvent({
        eventType: 'user_security_reviewed',
        category: 'admin_security',
        severity: 'low',
        source: 'admin',
        success: true,
        userId,
        actorUserId: adminUser._id,
        reason,
        metadata: {}
    });
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: userId,
        action: 'admin.security.mark_user_reviewed',
        reason,
        metadata: { reviewedAt: user.lastSecurityReviewAt }
    });
    return user;
}

async function getUserSecurityNotes(userId) {
    const user = await User.findById(userId).select('adminNotes');
    if (!user) return null;
    return (user.adminNotes || []).filter((note) => note.category === 'security').map((note) => ({
        id: String(note._id),
        body: note.body,
        category: note.category,
        author: note.author || 'system',
        createdAt: note.createdAt
    }));
}

async function addUserSecurityNote(userId, adminUser, payload, req) {
    const user = await User.findById(userId);
    if (!user) return null;
    user.adminNotes.push({
        body: String(payload.body).trim(),
        category: 'security',
        pinned: Boolean(payload.pinned),
        author: adminUser.email
    });
    await user.save();
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: userId,
        action: 'admin.security.add_user_note',
        reason: payload.reason || '',
        metadata: { pinned: Boolean(payload.pinned) }
    });
    return user;
}

async function acknowledgeSecurityEvent(eventId, adminUser, reason, req) {
    const event = await SecurityEvent.findById(eventId);
    if (!event) return null;
    event.acknowledgedAt = new Date();
    event.acknowledgedBy = adminUser.email;
    await event.save();
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: event.userId || null,
        targetSecurityEventId: event._id,
        targetSessionId: event.sessionId || null,
        action: 'admin.security.acknowledge_event',
        reason,
        metadata: {}
    });
    return event;
}

async function resolveSecurityEvent(eventId, adminUser, reason, req) {
    const event = await SecurityEvent.findById(eventId);
    if (!event) return null;
    event.resolvedAt = new Date();
    event.resolvedBy = adminUser.email;
    await event.save();
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: event.userId || null,
        targetSecurityEventId: event._id,
        targetSessionId: event.sessionId || null,
        action: 'admin.security.resolve_event',
        reason,
        metadata: {}
    });
    return event;
}

async function markSecurityEventReviewed(eventId, adminUser, reason, req) {
    const event = await SecurityEvent.findById(eventId);
    if (!event) return null;
    event.reviewedAt = new Date();
    event.reviewedBy = adminUser.email;
    await event.save();
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: event.userId || null,
        targetSecurityEventId: event._id,
        targetSessionId: event.sessionId || null,
        action: 'admin.security.mark_event_reviewed',
        reason,
        metadata: {}
    });
    return event;
}

async function getSecurityEventNotes(eventId) {
    const event = await SecurityEvent.findById(eventId).lean();
    if (!event) return null;
    return (event.notes || []).map((note) => ({
        id: String(note._id),
        body: note.body,
        category: note.category || 'review',
        author: note.author || 'system',
        createdAt: note.createdAt
    }));
}

async function addSecurityEventNote(eventId, adminUser, payload, req) {
    const event = await SecurityEvent.findById(eventId);
    if (!event) return null;
    event.notes.push({
        body: String(payload.body).trim(),
        category: payload.category || 'review',
        author: adminUser.email
    });
    await event.save();
    await recordAdminAction({
        req,
        actorUserId: adminUser._id,
        targetUserId: event.userId || null,
        targetSecurityEventId: event._id,
        targetSessionId: event.sessionId || null,
        action: 'admin.security.add_event_note',
        reason: payload.reason || '',
        metadata: { category: payload.category || 'review' }
    });
    return event;
}

async function getUserTimeline(userId, query = {}) {
    const [activity, audits, security] = await Promise.all([
        listGlobalActivity({ ...query, page: 1, limit: 500 }),
        listAuditTrail({ ...query, targetUserId: userId, page: 1, limit: 500 }),
        getUserSecurityEvents(userId, { ...query, page: 1, limit: 500 })
    ]);
    const items = activity.items.filter((item) => item.targetUser?.id === userId)
        .concat(audits.items.map((item) => ({ ...item, eventId: item.id, category: 'admin_audit', summary: item.reason || item.actionType, timestamp: item.timestamp })))
        .concat((security?.items || []).map((item) => ({ eventId: item.id, eventType: item.eventType, category: 'security', source: item.source, summary: item.reason || item.eventType, timestamp: item.timestamp, metadataPreview: item.metadata })))
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function getRouterTimeline(routerId, query = {}) {
    const [activity, audits] = await Promise.all([
        listGlobalActivity({ ...query, resourceType: 'router', page: 1, limit: 500 }),
        listAuditTrail({ ...query, resourceType: 'router', page: 1, limit: 500 })
    ]);
    const items = activity.items.filter((item) => item.resourceId === routerId)
        .concat(audits.items.filter((item) => item.resourceId === routerId).map((item) => ({ eventId: item.id, eventType: item.actionType, category: 'admin_audit', summary: item.reason || item.actionType, timestamp: item.timestamp, metadataPreview: item.metadata })))
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function getVpnServerTimeline(serverId, query = {}) {
    const [activity, audits] = await Promise.all([
        listGlobalActivity({ ...query, resourceType: 'vpn_server', page: 1, limit: 500 }),
        listAuditTrail({ ...query, resourceType: 'vpn_server', page: 1, limit: 500 })
    ]);
    const items = activity.items.filter((item) => item.resourceId === serverId)
        .concat(audits.items.filter((item) => item.resourceId === serverId).map((item) => ({ eventId: item.id, eventType: item.actionType, category: 'admin_audit', summary: item.reason || item.actionType, timestamp: item.timestamp, metadataPreview: item.metadata })))
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function getBillingAccountTimeline(accountId, query = {}) {
    return getUserTimeline(accountId, query);
}

async function getSupportTicketTimeline(ticketId, query = {}) {
    const [ticket, audits] = await Promise.all([
        SupportTicket.findById(ticketId)
            .populate('messages.userId', 'name email')
            .populate('workflowEvents.actorUserId', 'name email')
            .lean(),
        AdminAuditLog.find({ targetTicketId: ticketId }).populate('actorUserId', 'name email').sort({ createdAt: -1 }).lean()
    ]);
    if (!ticket) return null;
    const items = [];
    if ((ticket.workflowEvents || []).length) {
        (ticket.workflowEvents || []).forEach((event) => {
            items.push({
                eventId: `ticket:${ticket._id}:workflow:${event._id}`,
                eventType: event.eventType,
                category: 'support',
                source: event.actorType || 'system',
                summary: event.summary || event.eventType,
                timestamp: event.createdAt,
                metadataPreview: event.metadata || {}
            });
        });
    } else {
        items.push({
            eventId: `ticket:${ticket._id}:created`,
            eventType: 'ticket_created',
            category: 'support',
            source: 'user',
            summary: ticket.subject,
            timestamp: ticket.createdAt,
            metadataPreview: { status: ticket.status, priority: ticket.priority }
        });
    }
    (ticket.messages || []).forEach((message) => {
        items.push({
            eventId: `ticket:${ticket._id}:message:${message._id}`,
            eventType: 'ticket_message',
            category: 'support',
            source: message.source || 'user',
            summary: 'Support ticket message added',
            timestamp: message.createdAt,
            metadataPreview: { author: message.userId?.email || null, direction: message.source || 'customer' }
        });
    });
    if (ticket.resolvedAt) {
        items.push({
            eventId: `ticket:${ticket._id}:resolved`,
            eventType: 'ticket_resolved',
            category: 'support',
            source: 'system',
            summary: 'Support ticket resolved',
            timestamp: ticket.resolvedAt,
            metadataPreview: {}
        });
    }
    if (ticket.closedAt) {
        items.push({
            eventId: `ticket:${ticket._id}:closed`,
            eventType: 'ticket_closed',
            category: 'support',
            source: 'user',
            summary: 'Support ticket closed',
            timestamp: ticket.closedAt,
            metadataPreview: {}
        });
    }
    audits.forEach((audit) => {
        items.push({
            eventId: `audit:${audit._id}`,
            eventType: audit.action,
            category: 'admin_audit',
            source: 'admin',
            summary: audit.reason || audit.action,
            timestamp: audit.createdAt,
            metadataPreview: audit.metadata || {}
        });
    });
    items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function getIncidentTimeline(incidentId, query = {}) {
    const incident = await MonitoringIncident.findById(incidentId).lean();
    if (!incident) return null;
    const items = [{
        eventId: `incident:${incident._id}:created`,
        eventType: incident.type,
        category: 'incident',
        source: incident.source,
        summary: incident.title,
        timestamp: incident.firstDetectedAt || incident.createdAt,
        metadataPreview: incident.metadata || {}
    }];
    if (incident.acknowledgedAt) {
        items.push({
            eventId: `incident:${incident._id}:acknowledged`,
            eventType: 'incident_acknowledged',
            category: 'incident',
            source: 'admin',
            summary: 'Incident acknowledged',
            timestamp: incident.acknowledgedAt,
            metadataPreview: { acknowledgedBy: incident.acknowledgedBy }
        });
    }
    if (incident.reviewedAt) {
        items.push({
            eventId: `incident:${incident._id}:reviewed`,
            eventType: 'incident_reviewed',
            category: 'incident',
            source: 'admin',
            summary: 'Incident reviewed',
            timestamp: incident.reviewedAt,
            metadataPreview: { reviewedBy: incident.reviewedBy }
        });
    }
    if (incident.resolvedAt) {
        items.push({
            eventId: `incident:${incident._id}:resolved`,
            eventType: 'incident_resolved',
            category: 'incident',
            source: 'admin',
            summary: 'Incident resolved',
            timestamp: incident.resolvedAt,
            metadataPreview: { resolvedBy: incident.resolvedBy }
        });
    }
    return paginate(items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()), query.page, query.limit);
}

module.exports = {
    ADMIN_LOG_PERMISSIONS,
    SECURITY_REVIEW_NOTE_CATEGORIES,
    listGlobalActivity,
    getGlobalActivityEvent,
    listAuditTrail,
    getAuditDetail,
    getSecurityOverview,
    listSecurityEvents,
    getSecurityEventDetail,
    listSuspiciousActivity,
    listSecurityReviews,
    listSessions,
    listUserSessions,
    revokeSingleSession,
    revokeAllSessionsForUser,
    getUserSecuritySummary,
    getUserSecurityEvents,
    getUserSecurityReviews,
    markUserSecurityReviewed,
    getUserSecurityNotes,
    addUserSecurityNote,
    acknowledgeSecurityEvent,
    resolveSecurityEvent,
    markSecurityEventReviewed,
    getSecurityEventNotes,
    addSecurityEventNote,
    getUserTimeline,
    getRouterTimeline,
    getVpnServerTimeline,
    getBillingAccountTimeline,
    getSupportTicketTimeline,
    getIncidentTimeline
};
