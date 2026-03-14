const mongoose = require('mongoose');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const Client = require('../models/Client');
const AdminAuditLog = require('../models/AdminAuditLog');

const NOTE_CATEGORIES = ['billing', 'abuse', 'support', 'networking', 'onboarding', 'vip', 'technical', 'follow_up'];
const FLAG_TYPES = ['vip', 'watchlist', 'suspicious', 'overdue_billing', 'support_priority', 'manual_review'];
const FLAG_SEVERITIES = ['low', 'medium', 'high'];
const ADMIN_PERMISSIONS = {
    VIEW: 'admin.users.view',
    VIEW_DETAILS: 'admin.users.view_details',
    MANAGE_STATUS: 'admin.users.manage_status',
    VERIFY: 'admin.users.verify',
    FORCE_PASSWORD_RESET: 'admin.users.force_password_reset',
    FORCE_LOGOUT: 'admin.users.force_logout',
    EXTEND_TRIAL: 'admin.users.extend_trial',
    VIEW_BILLING: 'admin.users.view_billing',
    VIEW_SECURITY: 'admin.users.view_security',
    VIEW_SUPPORT: 'admin.users.view_support',
    ADD_NOTE: 'admin.users.add_note',
    FLAG: 'admin.users.flag',
    EXPORT: 'admin.users.export'
};

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function sortByDateDesc(items, key = 'timestamp') {
    return items.sort((a, b) => new Date(b[key]) - new Date(a[key]));
}

function buildAccountStatus(user) {
    if (!user.isActive) return 'suspended';
    if (!user.emailVerified) return 'pending_verification';
    return 'active';
}

function buildVerificationStatus(user) {
    return user.emailVerified ? 'verified' : 'unverified';
}

function buildRiskStatus(user) {
    if (user.riskStatus) return user.riskStatus;
    if ((user.failedLoginCount || 0) >= 5) return 'flagged';
    return 'normal';
}

function buildOperationalHealth({ overdueCount, offlineRouters, openTickets }) {
    if (overdueCount > 0 || offlineRouters > 0 || openTickets > 0) {
        if (overdueCount > 0 || offlineRouters >= 3) return 'critical';
        return 'warning';
    }

    return 'healthy';
}

function summarizeSubscription(subscriptions) {
    if (!subscriptions.length) {
        return {
            status: 'trial',
            planType: 'trial',
            monthlyValue: 0,
            nextBillingDate: null,
            overdueCount: 0,
            trialEndingSoon: false,
            billableRouters: 0,
            activeSubscriptions: 0
        };
    }

    const activeLike = subscriptions.find((subscription) => ['active', 'trial', 'past_due'].includes(subscription.status)) || subscriptions[0];
    const overdueCount = subscriptions.filter((subscription) => subscription.status === 'past_due').length;
    const trialEndingSoon = subscriptions.some((subscription) => subscription.trialEndsAt && (new Date(subscription.trialEndsAt).getTime() - Date.now()) < 3 * 24 * 60 * 60 * 1000 && new Date(subscription.trialEndsAt) > new Date());
    const monthlyValue = subscriptions.reduce((sum, subscription) => sum + (subscription.pricePerMonth || 0), 0);

    return {
        status: activeLike.status,
        planType: activeLike.planType,
        monthlyValue,
        nextBillingDate: activeLike.nextBillingDate || activeLike.currentPeriodEnd || null,
        overdueCount,
        trialEndingSoon,
        billableRouters: subscriptions.filter((subscription) => subscription.planType !== 'trial' || subscription.pricePerMonth > 0).length,
        activeSubscriptions: subscriptions.filter((subscription) => ['trial', 'active', 'past_due'].includes(subscription.status)).length
    };
}

function normalizeNote(note) {
    return {
        id: String(note._id),
        body: note.body,
        category: note.category || 'support',
        pinned: Boolean(note.pinned),
        author: note.author || 'system',
        createdAt: note.createdAt
    };
}

function normalizeFlag(flag) {
    return {
        id: String(flag._id),
        flag: flag.flag,
        severity: flag.severity || 'medium',
        description: flag.description || '',
        createdBy: flag.createdBy || 'system',
        createdAt: flag.createdAt
    };
}

function buildServicesSummary({ user, routers, subscriptions }) {
    const activeRouters = routers.filter((router) => router.status === 'active');
    const subscriptionSummary = summarizeSubscription(subscriptions);

    return {
        routerManagementEnabled: routers.length > 0,
        billableRouters: subscriptionSummary.billableRouters,
        totalRouters: routers.length,
        wireguardConnectivity: routers.length > 0,
        publicAccessPortsEnabled: routers.some((router) => Boolean(router.ports?.winbox || router.ports?.ssh || router.ports?.api)),
        monitoringEnabled: activeRouters.length > 0 || routers.some((router) => Boolean(router.routerboardInfo)),
        analyticsReporting: true,
        supportTier: user.supportTier || 'standard',
        trialFeaturesEnabled: Boolean(user.trialEndsAt && new Date(user.trialEndsAt) > new Date()),
        apiAccess: false,
        allocatedPublicPorts: routers.reduce((sum, router) => sum + Object.values(router.ports || {}).filter(Boolean).length, 0)
    };
}

function buildUserDirectoryRow(user, related) {
    const routers = related.routersByUser.get(String(user._id)) || [];
    const subscriptions = related.subscriptionsByUser.get(String(user._id)) || [];
    const tickets = related.ticketsByUser.get(String(user._id)) || [];
    const transactions = related.transactionsByUser.get(String(user._id)) || [];

    const onlineRouters = routers.filter((router) => router.status === 'active').length;
    const offlineRouters = routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length;
    const subscriptionSummary = summarizeSubscription(subscriptions);
    const openTickets = tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).length;
    const failedPayments = transactions.filter((transaction) => transaction.status === 'failed').length;
    const health = buildOperationalHealth({ overdueCount: subscriptionSummary.overdueCount, offlineRouters, openTickets });
    const flags = user.internalFlags || [];

    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        company: user.company || 'Independent',
        country: user.country || 'Unknown',
        phone: user.phone || 'N/A',
        accountStatus: buildAccountStatus(user),
        verificationStatus: buildVerificationStatus(user),
        subscriptionStatus: subscriptionSummary.status,
        billingState: subscriptionSummary.overdueCount > 0 ? 'overdue' : (subscriptions.length ? 'current' : 'none'),
        riskStatus: buildRiskStatus(user),
        riskIndicator: flags.length ? `${flags.length} flag(s)` : buildRiskStatus(user),
        supportTier: user.supportTier || 'standard',
        routersCount: routers.length,
        onlineRouters,
        offlineRouters,
        monthlyValue: subscriptionSummary.monthlyValue,
        planSummary: subscriptionSummary.planType || subscriptionSummary.status,
        openTickets,
        failedPayments,
        health,
        flagCount: flags.length,
        lastLoginAt: user.lastLoginAt || null,
        createdAt: user.createdAt,
        trialEndsAt: user.trialEndsAt || null
    };
}

function matchDateRange(value, from, to) {
    if (!from && !to) return true;
    if (!value) return false;
    const current = new Date(value).getTime();
    if (Number.isNaN(current)) return false;
    if (from && current < from.getTime()) return false;
    if (to && current > to.getTime()) return false;
    return true;
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

function getSortValue(row, sortBy) {
    switch (sortBy) {
        case 'name':
        case 'email':
        case 'company':
        case 'accountStatus':
        case 'verificationStatus':
        case 'subscriptionStatus':
        case 'riskStatus':
            return String(row[sortBy] || '').toLowerCase();
        case 'routersCount':
        case 'onlineRouters':
        case 'offlineRouters':
        case 'monthlyValue':
        case 'openTickets':
        case 'flagCount':
            return Number(row[sortBy] || 0);
        case 'lastLoginAt':
        case 'createdAt':
            return row[sortBy] ? new Date(row[sortBy]).getTime() : 0;
        default:
            return row.createdAt ? new Date(row.createdAt).getTime() : 0;
    }
}

function sortDirectoryRows(rows, sortBy = 'createdAt', sortOrder = 'desc') {
    const direction = sortOrder === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const aValue = getSortValue(a, sortBy);
        const bValue = getSortValue(b, sortBy);
        if (aValue < bValue) return -1 * direction;
        if (aValue > bValue) return 1 * direction;
        return 0;
    });
}

function escapeCsv(value) {
    const serialized = value === null || value === undefined ? '' : String(value);
    if (!serialized.includes(',') && !serialized.includes('"') && !serialized.includes('\n')) {
        return serialized;
    }
    return `"${serialized.replace(/"/g, '""')}"`;
}

function serializeUsersAsCsv(rows) {
    const header = ['id', 'name', 'email', 'company', 'country', 'accountStatus', 'verificationStatus', 'subscriptionStatus', 'routersCount', 'onlineRouters', 'offlineRouters', 'monthlyValue', 'riskIndicator', 'lastLoginAt', 'createdAt'];
    const lines = rows.map((row) => header.map((key) => escapeCsv(row[key])).join(','));
    return [header.join(','), ...lines].join('\n');
}

async function loadDirectoryData(filters = {}) {
    const query = {};
    const createdFrom = toDateOrNull(filters.createdFrom);
    const createdTo = toDateOrNull(filters.createdTo);
    const lastLoginFrom = toDateOrNull(filters.lastLoginFrom);
    const lastLoginTo = toDateOrNull(filters.lastLoginTo);
    const searchTerm = String(filters.q || '').trim();

    if (filters.accountStatus === 'active') query.isActive = true;
    if (filters.accountStatus === 'suspended') query.isActive = false;
    if (filters.verificationStatus === 'verified') query.emailVerified = true;
    if (filters.verificationStatus === 'unverified') query.emailVerified = false;
    if (filters.riskStatus) query.riskStatus = filters.riskStatus;
    if (createdFrom || createdTo) {
        query.createdAt = {};
        if (createdFrom) query.createdAt.$gte = createdFrom;
        if (createdTo) query.createdAt.$lte = createdTo;
    }
    if (lastLoginFrom || lastLoginTo) {
        query.lastLoginAt = {};
        if (lastLoginFrom) query.lastLoginAt.$gte = lastLoginFrom;
        if (lastLoginTo) query.lastLoginAt.$lte = lastLoginTo;
    }

    if (searchTerm) {
        const regex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const orQuery = [
            { name: { $regex: regex } },
            { email: { $regex: regex } },
            { company: { $regex: regex } },
            { phone: { $regex: regex } }
        ];

        if (mongoose.Types.ObjectId.isValid(searchTerm)) {
            orQuery.push({ _id: new mongoose.Types.ObjectId(searchTerm) });
        }

        const routers = await MikrotikRouter.find({ name: { $regex: regex } }, { userId: 1 }).lean();
        const routerUserIds = [...new Set(routers.map((router) => String(router.userId)).filter(Boolean))].map((id) => new mongoose.Types.ObjectId(id));
        if (routerUserIds.length) {
            orQuery.push({ _id: { $in: routerUserIds } });
        }

        query.$or = orQuery;
    }

    const users = await User.find(query).sort({ createdAt: -1 }).lean();
    const userIds = users.map((user) => user._id);

    const [routers, subscriptions, tickets, transactions] = await Promise.all([
        MikrotikRouter.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean(),
        Subscription.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean(),
        SupportTicket.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean(),
        Transaction.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean()
    ]);

    const groupByUser = (items) => items.reduce((map, item) => {
        const key = String(item.userId);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
        return map;
    }, new Map());

    return {
        users,
        related: {
            routersByUser: groupByUser(routers),
            subscriptionsByUser: groupByUser(subscriptions),
            ticketsByUser: groupByUser(tickets),
            transactionsByUser: groupByUser(transactions)
        }
    };
}

async function getAdminUserStats() {
    const [users, routers, subscriptions, tickets] = await Promise.all([
        User.find().lean(),
        MikrotikRouter.find().lean(),
        Subscription.find().lean(),
        SupportTicket.find().lean()
    ]);

    const usersWithOfflineRouters = new Set(routers.filter((router) => ['offline', 'inactive'].includes(router.status)).map((router) => String(router.userId)));
    const usersWithOpenSupportTickets = new Set(tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).map((ticket) => String(ticket.userId)));
    const overdueBillingUsers = new Set(subscriptions.filter((subscription) => subscription.status === 'past_due').map((subscription) => String(subscription.userId)));

    return {
        totalUsers: users.length,
        activeUsers: users.filter((user) => user.isActive).length,
        trialUsers: users.filter((user) => user.trialEndsAt && new Date(user.trialEndsAt) > new Date()).length,
        suspendedUsers: users.filter((user) => !user.isActive).length,
        verifiedUsers: users.filter((user) => user.emailVerified).length,
        overdueBillingUsers: overdueBillingUsers.size,
        usersWithOfflineRouters: usersWithOfflineRouters.size,
        usersWithOpenSupportTickets: usersWithOpenSupportTickets.size
    };
}

async function listAdminUsers(filters = {}) {
    const { users, related } = await loadDirectoryData(filters);
    let rows = users.map((user) => buildUserDirectoryRow(user, related));

    rows = rows.filter((row) => {
        if (filters.subscriptionStatus && row.subscriptionStatus !== filters.subscriptionStatus) return false;
        if (filters.billingState && row.billingState !== filters.billingState) return false;
        if (filters.supportState === 'has_open_tickets' && row.openTickets <= 0) return false;
        if (filters.supportState === 'no_tickets' && row.openTickets > 0) return false;
        if (filters.routerOwnershipState === 'none' && row.routersCount > 0) return false;
        if (filters.routerOwnershipState === 'has_routers' && row.routersCount === 0) return false;
        if (filters.routerOwnershipState === 'has_offline_routers' && row.offlineRouters === 0) return false;
        if (!matchDateRange(row.createdAt, toDateOrNull(filters.createdFrom), toDateOrNull(filters.createdTo))) return false;
        if (!matchDateRange(row.lastLoginAt, toDateOrNull(filters.lastLoginFrom), toDateOrNull(filters.lastLoginTo))) return false;
        return true;
    });

    rows = sortDirectoryRows(rows, filters.sortBy, filters.sortOrder);

    if (String(filters.format || '').toLowerCase() === 'csv') {
        return {
            format: 'csv',
            csv: serializeUsersAsCsv(rows),
            total: rows.length
        };
    }

    const paginated = paginate(rows, filters.page, filters.limit);
    return {
        format: 'json',
        items: paginated.items,
        pagination: paginated.pagination
    };
}

function formatAuditEvent(entry) {
    return {
        id: String(entry._id),
        type: 'admin_action',
        source: 'admin',
        actor: entry.actorUserId?.email || entry.actorUserId?.name || 'admin',
        actorId: entry.actorUserId?._id ? String(entry.actorUserId._id) : (entry.actorUserId ? String(entry.actorUserId) : null),
        action: entry.action,
        summary: entry.reason ? `${entry.action}: ${entry.reason}` : entry.action,
        metadata: entry.metadata || {},
        timestamp: entry.createdAt,
        ipAddress: entry.ipAddress || null,
        userAgent: entry.userAgent || null
    };
}

function deriveActivity(user, routers, subscriptions, transactions, tickets, auditLogs = []) {
    const events = [];

    events.push({
        id: `account-created-${user._id}`,
        type: 'account_created',
        actor: 'system',
        source: 'system',
        timestamp: user.createdAt,
        summary: 'Account created',
        metadata: user.email
    });

    if (user.lastVerificationEmailSentAt) {
        events.push({
            id: `verification-sent-${user._id}`,
            type: 'verification_email_sent',
            actor: 'system',
            source: 'auth',
            timestamp: user.lastVerificationEmailSentAt,
            summary: 'Verification email sent',
            metadata: user.email
        });
    }

    if (user.emailVerified) {
        events.push({
            id: `email-verified-${user._id}`,
            type: 'email_verified',
            actor: 'system',
            source: 'auth',
            timestamp: user.emailVerifiedAt || user.updatedAt,
            summary: 'Email verified',
            metadata: user.email
        });
    }

    if (user.lastLoginAt) {
        events.push({
            id: `login-${user._id}`,
            type: 'login',
            actor: user.name,
            source: 'user',
            timestamp: user.lastLoginAt,
            summary: 'Successful login',
            metadata: user.email
        });
    }

    if (user.lastFailedLoginAt) {
        events.push({
            id: `failed-login-${user._id}`,
            type: 'failed_login',
            actor: user.email,
            source: 'security',
            timestamp: user.lastFailedLoginAt,
            summary: 'Failed login attempt recorded',
            metadata: `${user.failedLoginCount || 1} failed attempts`
        });
    }

    if (user.passwordResetRequestedAt) {
        events.push({
            id: `password-reset-requested-${user._id}`,
            type: 'password_reset_requested',
            actor: user.email,
            source: 'auth',
            timestamp: user.passwordResetRequestedAt,
            summary: 'Password reset requested',
            metadata: user.email
        });
    }

    if (user.passwordResetCompletedAt) {
        events.push({
            id: `password-reset-completed-${user._id}`,
            type: 'password_reset_completed',
            actor: user.email,
            source: 'auth',
            timestamp: user.passwordResetCompletedAt,
            summary: 'Password reset completed',
            metadata: user.email
        });
    }

    routers.forEach((router) => {
        events.push({
            id: `router-${router._id}`,
            type: 'router_event',
            actor: 'system',
            source: 'router',
            timestamp: router.updatedAt || router.createdAt,
            summary: `${router.name} is ${router.status}`,
            metadata: {
                routerId: String(router._id),
                vpnIp: router.vpnIp,
                ports: router.ports
            }
        });
    });

    subscriptions.forEach((subscription) => {
        events.push({
            id: `subscription-${subscription._id}`,
            type: 'subscription_event',
            actor: 'billing',
            source: 'billing',
            timestamp: subscription.updatedAt || subscription.createdAt,
            summary: `Subscription ${subscription.status}`,
            metadata: {
                subscriptionId: String(subscription._id),
                routerId: subscription.routerId ? String(subscription.routerId) : null,
                planType: subscription.planType,
                pricePerMonth: subscription.pricePerMonth
            }
        });
    });

    transactions.forEach((transaction) => {
        events.push({
            id: `transaction-${transaction._id}`,
            type: transaction.status === 'failed' ? 'payment_failed' : 'payment_event',
            actor: 'billing',
            source: 'billing',
            timestamp: transaction.createdAt,
            summary: `${transaction.type} ${transaction.status}`,
            metadata: {
                transactionId: transaction.transactionId,
                amount: transaction.amount,
                currency: transaction.currency,
                status: transaction.status
            }
        });
    });

    tickets.forEach((ticket) => {
        events.push({
            id: `ticket-${ticket._id}`,
            type: 'support_event',
            actor: 'support',
            source: 'support',
            timestamp: ticket.updatedAt || ticket.createdAt,
            summary: `Ticket ${ticket.status}: ${ticket.subject}`,
            metadata: {
                ticketId: String(ticket._id),
                category: ticket.category,
                priority: ticket.priority
            }
        });
    });

    auditLogs.forEach((entry) => {
        events.push(formatAuditEvent(entry));
    });

    return sortByDateDesc(events.filter((event) => Boolean(event.timestamp))).slice(0, 500);
}

async function getUserBundle(userId) {
    const user = await User.findById(userId).lean();
    if (!user) {
        return null;
    }

    const [routers, subscriptions, transactions, tickets, auditLogs] = await Promise.all([
        MikrotikRouter.find({ userId: user._id }).populate('wireguardClientId').sort({ createdAt: -1 }).lean(),
        Subscription.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
        Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
        SupportTicket.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
        AdminAuditLog.find({ targetUserId: user._id }).populate('actorUserId', 'name email').sort({ createdAt: -1 }).lean()
    ]);

    const clientIds = routers.map((router) => router.wireguardClientId?._id).filter(Boolean);
    const clients = clientIds.length ? await Client.find({ _id: { $in: clientIds } }).lean() : [];
    const clientById = new Map(clients.map((client) => [String(client._id), client]));

    return {
        user,
        routers,
        subscriptions,
        transactions,
        tickets,
        auditLogs,
        clientById
    };
}

function buildRoutersView(routers, clientById) {
    return routers.map((router) => {
        const linkedClient = router.wireguardClientId ? clientById.get(String(router.wireguardClientId._id || router.wireguardClientId)) : null;
        return {
            id: String(router._id),
            name: router.name,
            status: router.status,
            vpnIp: router.vpnIp,
            assignedPublicPorts: router.ports,
            ports: router.ports,
            serverNode: 'wireguard',
            location: router.routerboardInfo?.boardName || null,
            lastSeen: router.lastSeen || null,
            firstConnectedAt: router.firstConnectedAt || null,
            setupStatus: router.status === 'pending' ? 'pending' : 'configured',
            usage: {
                transferRx: linkedClient?.transferRx || 0,
                transferTx: linkedClient?.transferTx || 0,
                lastHandshake: linkedClient?.lastHandshake || null
            },
            wireguardClient: linkedClient ? {
                id: String(linkedClient._id),
                name: linkedClient.name,
                ip: linkedClient.ip,
                enabled: linkedClient.enabled
            } : null,
            routerboardInfo: router.routerboardInfo || null,
            createdAt: router.createdAt
        };
    });
}

function buildSupportSummary(tickets) {
    return {
        totalTickets: tickets.length,
        openTickets: tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).length,
        closedTickets: tickets.filter((ticket) => ticket.status === 'closed').length,
        urgentTickets: tickets.filter((ticket) => ticket.priority === 'urgent').length
    };
}

function buildBillingPayload({ user, routers, subscriptions, transactions }) {
    const summary = summarizeSubscription(subscriptions);
    const recentTransactions = transactions.slice(0, 20).map((transaction) => ({
        id: String(transaction._id),
        transactionId: transaction.transactionId,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        description: transaction.description,
        createdAt: transaction.createdAt
    }));

    return {
        currentPlan: summary.planType || summary.status,
        pricingAmount: summary.monthlyValue,
        billingCycle: summary.planType === 'trial' ? 'trial' : 'monthly',
        billableRouters: summary.billableRouters,
        routersCount: routers.length,
        nextBillingDate: summary.nextBillingDate,
        trialStart: user.createdAt,
        trialEnd: user.trialEndsAt || null,
        balance: user.balance || 0,
        currency: user.currency || 'USD',
        overdue: summary.overdueCount > 0,
        summary,
        subscriptions,
        recentTransactions
    };
}

function buildSecurityPayload({ user, activity, auditLogs }) {
    const securityEvents = activity.filter((event) => ['login', 'failed_login', 'password_reset_requested', 'password_reset_completed', 'email_verified', 'verification_email_sent', 'admin_action'].includes(event.type));
    const sessionHistory = auditLogs
        .filter((entry) => ['admin.users.force_logout', 'admin.users.send_password_reset', 'admin.users.mark_security_reviewed'].includes(entry.action))
        .map((entry) => formatAuditEvent(entry));

    return {
        lastSuccessfulLogin: user.lastLoginAt || null,
        lastFailedLogin: user.lastFailedLoginAt || null,
        failedLogins24h: user.lastFailedLoginAt && (Date.now() - new Date(user.lastFailedLoginAt).getTime()) < 24 * 60 * 60 * 1000 ? user.failedLoginCount || 1 : 0,
        failedLogins7d: user.lastFailedLoginAt && (Date.now() - new Date(user.lastFailedLoginAt).getTime()) < 7 * 24 * 60 * 60 * 1000 ? user.failedLoginCount || 1 : 0,
        passwordResetRequestedAt: user.passwordResetRequestedAt || null,
        passwordResetCompletedAt: user.passwordResetCompletedAt || null,
        verificationEmailSentAt: user.lastVerificationEmailSentAt || null,
        verifiedAt: user.emailVerifiedAt || null,
        activeSessionsCount: user.lastLoginAt && (!user.sessionsRevokedAt || new Date(user.lastLoginAt) > new Date(user.sessionsRevokedAt)) ? 1 : 0,
        sessionsRevokedAt: user.sessionsRevokedAt || null,
        loginIp: null,
        userAgent: null,
        suspiciousIpCount: 0,
        riskStatus: buildRiskStatus(user),
        flags: (user.internalFlags || []).map(normalizeFlag),
        events: securityEvents.slice(0, 30),
        sessionHistory: sortByDateDesc(sessionHistory).slice(0, 20)
    };
}

async function getAdminUserDetail(userId) {
    const bundle = await getUserBundle(userId);
    if (!bundle) {
        return null;
    }

    const { user, routers, subscriptions, transactions, tickets, auditLogs, clientById } = bundle;
    const onlineRouters = routers.filter((router) => router.status === 'active').length;
    const offlineRouters = routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length;
    const subscriptionSummary = summarizeSubscription(subscriptions);
    const openTickets = tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).length;
    const health = buildOperationalHealth({ overdueCount: subscriptionSummary.overdueCount, offlineRouters, openTickets });
    const activity = deriveActivity(user, routers, subscriptions, transactions, tickets, auditLogs);
    const routersView = buildRoutersView(routers, clientById);
    const services = buildServicesSummary({ user, routers, subscriptions });

    return {
        id: String(user._id),
        profile: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            company: user.company || 'Independent',
            phone: user.phone || null,
            country: user.country || 'Unknown',
            timezone: user.timezone || 'UTC',
            createdAt: user.createdAt,
            verifiedAt: user.emailVerifiedAt || (user.emailVerified ? user.updatedAt : null),
            referralCode: user.referralCode || null,
            supportTier: user.supportTier || 'standard'
        },
        state: {
            accountStatus: buildAccountStatus(user),
            verificationStatus: buildVerificationStatus(user),
            subscriptionStatus: subscriptionSummary.status,
            trialStatus: user.trialEndsAt && new Date(user.trialEndsAt) > new Date() ? 'trial' : 'standard',
            billingState: subscriptionSummary.overdueCount > 0 ? 'overdue' : (subscriptions.length ? 'current' : 'none'),
            riskStatus: buildRiskStatus(user),
            health
        },
        summary: {
            routersOwned: routers.length,
            onlineRouters,
            offlineRouters,
            activeSubscriptionValue: subscriptionSummary.monthlyValue,
            totalMonthlySpend: subscriptionSummary.monthlyValue,
            lastLogin: user.lastLoginAt || null,
            openTickets,
            failedLoginCount: user.failedLoginCount || 0,
            accountAgeDays: Math.max(1, Math.round((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24))),
            lastActivity: activity[0]?.timestamp || user.updatedAt
        },
        services,
        insights: [
            routers.length ? `User owns ${routers.length} routers, ${offlineRouters} offline.` : 'User has not provisioned any routers yet.',
            subscriptionSummary.trialEndingSoon ? 'Trial is ending soon.' : 'Subscription lifecycle is stable.',
            subscriptionSummary.overdueCount > 0 ? 'Billing follow-up required.' : 'No overdue billing detected.',
            openTickets > 0 ? `${openTickets} open support ticket(s) require attention.` : 'No open support burden at the moment.',
            (user.failedLoginCount || 0) > 0 ? `Recent failed logins: ${user.failedLoginCount}.` : 'No recent failed login risk detected.'
        ],
        routers: routersView,
        billing: buildBillingPayload({ user, routers, subscriptions, transactions }),
        activity: activity.slice(0, 20),
        security: buildSecurityPayload({ user, activity, auditLogs }),
        support: {
            summary: buildSupportSummary(tickets),
            tickets: tickets.slice(0, 20)
        },
        notes: (user.adminNotes || []).map(normalizeNote),
        flags: (user.internalFlags || []).map(normalizeFlag)
    };
}

async function getAdminUserServices(userId) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;
    return buildServicesSummary(bundle);
}

async function getAdminUserRouters(userId) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;

    const items = buildRoutersView(bundle.routers, bundle.clientById);
    return {
        summary: {
            totalRouters: items.length,
            onlineRouters: items.filter((router) => router.status === 'active').length,
            offlineRouters: items.filter((router) => ['offline', 'inactive'].includes(router.status)).length
        },
        items
    };
}

async function getAdminUserBilling(userId) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;
    return buildBillingPayload(bundle);
}

async function getAdminUserActivity(userId, filters = {}) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;

    let items = deriveActivity(bundle.user, bundle.routers, bundle.subscriptions, bundle.transactions, bundle.tickets, bundle.auditLogs);

    if (filters.type) {
        items = items.filter((item) => item.type === filters.type);
    }
    if (filters.source) {
        items = items.filter((item) => item.source === filters.source);
    }
    if (filters.actor) {
        const actor = String(filters.actor).toLowerCase();
        items = items.filter((item) => String(item.actor || '').toLowerCase().includes(actor));
    }
    if (filters.from || filters.to) {
        const from = toDateOrNull(filters.from);
        const to = toDateOrNull(filters.to);
        items = items.filter((item) => matchDateRange(item.timestamp, from, to));
    }

    return paginate(items, filters.page, filters.limit);
}

async function getAdminUserSecurity(userId) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;
    const activity = deriveActivity(bundle.user, bundle.routers, bundle.subscriptions, bundle.transactions, bundle.tickets, bundle.auditLogs);
    return buildSecurityPayload({ user: bundle.user, activity, auditLogs: bundle.auditLogs });
}

async function getAdminUserSupport(userId, filters = {}) {
    const bundle = await getUserBundle(userId);
    if (!bundle) return null;

    let tickets = bundle.tickets;
    if (filters.status) tickets = tickets.filter((ticket) => ticket.status === filters.status);
    if (filters.category) tickets = tickets.filter((ticket) => ticket.category === filters.category);
    if (filters.priority) tickets = tickets.filter((ticket) => ticket.priority === filters.priority);

    const paginated = paginate(tickets, filters.page, filters.limit);
    return {
        summary: buildSupportSummary(bundle.tickets),
        items: paginated.items,
        pagination: paginated.pagination
    };
}

async function getAdminUserNotes(userId) {
    const user = await User.findById(userId).select('adminNotes');
    if (!user) return null;
    return (user.adminNotes || []).map(normalizeNote).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getAdminUserFlags(userId) {
    const user = await User.findById(userId).select('internalFlags riskStatus');
    if (!user) return null;
    return {
        riskStatus: buildRiskStatus(user),
        items: (user.internalFlags || []).map(normalizeFlag).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    };
}

module.exports = {
    ADMIN_PERMISSIONS,
    NOTE_CATEGORIES,
    FLAG_TYPES,
    FLAG_SEVERITIES,
    buildAccountStatus,
    buildVerificationStatus,
    buildRiskStatus,
    summarizeSubscription,
    normalizeNote,
    normalizeFlag,
    getAdminUserStats,
    listAdminUsers,
    getAdminUserDetail,
    getAdminUserServices,
    getAdminUserRouters,
    getAdminUserBilling,
    getAdminUserActivity,
    getAdminUserSecurity,
    getAdminUserSupport,
    getAdminUserNotes,
    getAdminUserFlags
};
