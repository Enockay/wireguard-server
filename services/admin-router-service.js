const mongoose = require('mongoose');
const MikrotikRouter = require('../models/MikrotikRouter');
const User = require('../models/User');
const Client = require('../models/Client');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const AdminAuditLog = require('../models/AdminAuditLog');
const { allocatePorts, releasePorts } = require('../utils/port-allocator');
const { generateKeys, getNextAvailableIP } = require('../utils/route-helpers');
const { startRouterProxy, stopRouterProxy, restartRouterProxy, getProxyStatus } = require('./tcp-proxy-service');
const { wgLock, runWgCommand, KEEPALIVE_TIME, validateKeepalive, getServerEndpoint, getServerPublicKey } = require('../wg-core');
const { sendRouterDeletedEmail } = require('./email-service');

const ROUTER_NOTE_CATEGORIES = ['support', 'provisioning', 'monitoring', 'billing', 'abuse', 'infrastructure', 'follow_up'];
const ROUTER_FLAG_TYPES = ['provisioning_issue', 'unstable', 'under_investigation', 'vip_customer_router', 'billing_hold', 'manual_review'];
const ROUTER_FLAG_SEVERITIES = ['low', 'medium', 'high'];
const ADMIN_ROUTER_PERMISSIONS = {
    VIEW: 'admin.routers.view',
    VIEW_DETAILS: 'admin.routers.view_details',
    VIEW_CONNECTIVITY: 'admin.routers.view_connectivity',
    VIEW_MONITORING: 'admin.routers.view_monitoring',
    VIEW_BILLING_CONTEXT: 'admin.routers.view_billing_context',
    MANAGE_STATUS: 'admin.routers.manage_status',
    REPROVISION: 'admin.routers.reprovision',
    RESET_KEYS: 'admin.routers.reset_keys',
    REASSIGN_PORTS: 'admin.routers.reassign_ports',
    MOVE_SERVER: 'admin.routers.move_server',
    DELETE: 'admin.routers.delete',
    ADD_NOTE: 'admin.routers.add_note',
    FLAG: 'admin.routers.flag',
    EXPORT: 'admin.routers.export'
};

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatPublicKeyFingerprint(key) {
    if (!key || typeof key !== 'string') return null;
    return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function getLastHandshakeDate(client) {
    return client?.lastHandshake ? new Date(client.lastHandshake) : null;
}

function getHandshakeState(client) {
    const handshake = getLastHandshakeDate(client);
    if (!handshake) return 'never';
    return (Date.now() - handshake.getTime()) > 180000 ? 'stale' : 'fresh';
}

function deriveSetupStatus(router, client) {
    if (!client) return 'failed';
    if (router.status === 'inactive') return 'disabled';
    if (router.firstConnectedAt) return 'connected';
    if (router.provisioningError) return 'failed';
    if (router.lastSetupGeneratedAt || client.createdAt) return 'awaiting_connection';
    return 'pending';
}

function deriveConnectionStatus(router, client) {
    if (router.status === 'inactive') return 'disabled';
    if (!client || !client.enabled) return 'peer_disabled';
    if (router.status === 'active') return 'online';
    if (router.status === 'offline') return 'offline';
    return 'pending';
}

function deriveHealthSummary(router, client) {
    const issues = [];
    const handshakeState = getHandshakeState(client);

    if (!router.ports?.winbox || !router.ports?.ssh || !router.ports?.api) {
        issues.push('missing_ports');
    }
    if (!client) {
        issues.push('missing_peer');
    }
    if (client && !client.enabled) {
        issues.push('peer_disabled');
    }
    if (router.status === 'offline') {
        issues.push('router_offline');
    }
    if (handshakeState === 'never') {
        issues.push('no_handshake');
    }
    if (handshakeState === 'stale') {
        issues.push('stale_handshake');
    }
    if (router.provisioningError) {
        issues.push('provisioning_error');
    }

    const severity = issues.length === 0 ? 'healthy' : (issues.includes('missing_peer') || issues.includes('provisioning_error') ? 'critical' : 'warning');
    return {
        state: severity,
        issues
    };
}

function normalizeRouterNote(note) {
    return {
        id: String(note._id),
        body: note.body,
        category: note.category || 'support',
        pinned: Boolean(note.pinned),
        author: note.author || 'system',
        createdAt: note.createdAt
    };
}

function normalizeRouterFlag(flag) {
    return {
        id: String(flag._id),
        flag: flag.flag,
        severity: flag.severity || 'medium',
        description: flag.description || '',
        createdBy: flag.createdBy || 'system',
        createdAt: flag.createdAt
    };
}

function normalizeSubscription(subscription) {
    if (!subscription) return null;
    return {
        id: String(subscription._id),
        status: subscription.status,
        planType: subscription.planType,
        pricePerMonth: subscription.pricePerMonth,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEndsAt: subscription.trialEndsAt,
        nextBillingDate: subscription.nextBillingDate,
        paymentMethod: subscription.paymentMethod
    };
}

function buildCustomerSummary(user, routersOwned = 0, supportSummary = null, subscription = null) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        accountStatus: user.isActive ? 'active' : 'suspended',
        verificationStatus: user.emailVerified ? 'verified' : 'unverified',
        routersOwned,
        supportState: supportSummary?.openTickets > 0 ? 'has_open_tickets' : 'no_open_tickets',
        subscriptionState: subscription?.status || 'none'
    };
}

function buildPortsSummary(router) {
    const proxyStatus = getProxyStatus(router._id);
    const ports = router.ports || {};

    return {
        winbox: {
            publicPort: ports.winbox || null,
            targetPort: 8291,
            allocationStatus: ports.winbox ? 'assigned' : 'missing',
            forwardingStatus: proxyStatus.running ? (proxyStatus.winbox?.listening ? 'listening' : 'not_listening') : 'stopped'
        },
        ssh: {
            publicPort: ports.ssh || null,
            targetPort: 22,
            allocationStatus: ports.ssh ? 'assigned' : 'missing',
            forwardingStatus: proxyStatus.running ? (proxyStatus.ssh?.listening ? 'listening' : 'not_listening') : 'stopped'
        },
        api: {
            publicPort: ports.api || null,
            targetPort: 8728,
            allocationStatus: ports.api ? 'assigned' : 'missing',
            forwardingStatus: proxyStatus.running ? (proxyStatus.api?.listening ? 'listening' : 'not_listening') : 'stopped'
        },
        proxyStatus
    };
}

function buildMonitoringSummary(router, client) {
    const lastHandshake = getLastHandshakeDate(client);
    const health = deriveHealthSummary(router, client);

    return {
        online: router.status === 'active',
        status: router.status,
        lastSeen: router.lastSeen || null,
        lastHandshake: lastHandshake || null,
        handshakeState: getHandshakeState(client),
        transferRx: client?.transferRx || 0,
        transferTx: client?.transferTx || 0,
        uptime: router.routerboardInfo?.uptime || null,
        cpuLoad: router.routerboardInfo?.cpuLoad || null,
        memoryUsage: router.routerboardInfo?.memoryUsage || null,
        totalMemory: router.routerboardInfo?.totalMemory || null,
        freeMemory: router.routerboardInfo?.freeMemory || null,
        firmware: router.routerboardInfo?.firmware || null,
        lastTelemetryAt: router.routerboardInfo?.lastChecked || null,
        staleTelemetry: router.routerboardInfo?.lastChecked ? (Date.now() - new Date(router.routerboardInfo.lastChecked).getTime()) > 10 * 60 * 1000 : true,
        health
    };
}

function buildConnectivitySummary(router, client) {
    const lastHandshake = getLastHandshakeDate(client);
    return {
        peerId: client ? String(client._id) : null,
        peerEnabled: Boolean(client?.enabled),
        peerName: client?.name || null,
        serverNode: router.serverNode || 'wireguard',
        vpnIp: router.vpnIp,
        allowedIPs: client?.allowedIPs || router.vpnIp,
        publicKeyFingerprint: formatPublicKeyFingerprint(client?.publicKey),
        tunnelStatus: deriveConnectionStatus(router, client),
        lastHandshake: lastHandshake || null,
        handshakeState: getHandshakeState(client),
        transferRx: client?.transferRx || 0,
        transferTx: client?.transferTx || 0,
        peerCreatedAt: client?.createdAt || null,
        configGenerationStatus: router.lastSetupGeneratedAt ? 'generated' : (client ? 'available' : 'missing'),
        rekeyEligible: Boolean(client),
        reconciliationState: client ? (client.enabled ? 'managed' : 'disabled') : 'missing'
    };
}

async function loadRouterDirectoryData() {
    const [routers, users, subscriptions, transactions] = await Promise.all([
        MikrotikRouter.find({})
            .populate('userId', 'name email isActive emailVerified')
            .populate('wireguardClientId')
            .sort({ createdAt: -1 })
            .lean(),
        User.find({}, 'name email isActive emailVerified').lean(),
        Subscription.find({}).lean(),
        Transaction.find({ routerId: { $exists: true, $ne: null } }).lean()
    ]);

    const userRouterCounts = routers.reduce((map, router) => {
        const key = String(router.userId?._id || router.userId);
        map.set(key, (map.get(key) || 0) + 1);
        return map;
    }, new Map());

    const supportSummaryByUser = new Map();
    return {
        routers,
        users,
        subscriptionsByRouterId: new Map(subscriptions.map((item) => [String(item.routerId), item])),
        transactionsByRouterId: transactions.reduce((map, item) => {
            const key = String(item.routerId);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(item);
            return map;
        }, new Map()),
        userRouterCounts,
        supportSummaryByUser
    };
}

function buildRouterListItem(router, related) {
    const owner = router.userId;
    const client = router.wireguardClientId || null;
    const subscription = related.subscriptionsByRouterId.get(String(router._id)) || null;
    const health = deriveHealthSummary(router, client);
    const monitoring = buildMonitoringSummary(router, client);

    return {
        id: String(router._id),
        name: router.name,
        customer: owner ? buildCustomerSummary(owner, related.userRouterCounts.get(String(owner._id)) || 0, null, subscription) : null,
        status: router.status,
        setupStatus: deriveSetupStatus(router, client),
        connectionStatus: deriveConnectionStatus(router, client),
        vpnIp: router.vpnIp,
        serverNode: router.serverNode || 'wireguard',
        winboxPort: router.ports?.winbox || null,
        sshPort: router.ports?.ssh || null,
        apiPort: router.ports?.api || null,
        location: router.routerboardInfo?.boardName || null,
        lastSeen: router.lastSeen || null,
        lastHandshake: getLastHandshakeDate(client),
        healthSummary: health,
        createdAt: router.createdAt,
        billingState: subscription?.status || 'none',
        issueFlags: (router.internalFlags || []).map((flag) => flag.flag),
        unhealthy: monitoring.health.state !== 'healthy'
    };
}

function matchDateRange(value, from, to) {
    if (!from && !to) return true;
    if (!value) return false;
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) return false;
    if (from && timestamp < from.getTime()) return false;
    if (to && timestamp > to.getTime()) return false;
    return true;
}

function getSortValue(row, sortBy) {
    switch (sortBy) {
        case 'name':
        case 'status':
        case 'setupStatus':
        case 'connectionStatus':
        case 'vpnIp':
        case 'serverNode':
        case 'billingState':
            return String(row[sortBy] || '').toLowerCase();
        case 'winboxPort':
        case 'sshPort':
        case 'apiPort':
            return Number(row[sortBy] || 0);
        case 'lastSeen':
        case 'lastHandshake':
        case 'createdAt':
            return row[sortBy] ? new Date(row[sortBy]).getTime() : 0;
        default:
            return row.createdAt ? new Date(row.createdAt).getTime() : 0;
    }
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

function escapeCsv(value) {
    const serialized = value === null || value === undefined ? '' : String(value);
    if (!serialized.includes(',') && !serialized.includes('"') && !serialized.includes('\n')) return serialized;
    return `"${serialized.replace(/"/g, '""')}"`;
}

function serializeRoutersAsCsv(rows) {
    const header = ['id', 'name', 'status', 'setupStatus', 'connectionStatus', 'vpnIp', 'serverNode', 'winboxPort', 'sshPort', 'apiPort', 'lastSeen', 'lastHandshake', 'billingState', 'createdAt'];
    const lines = rows.map((row) => header.map((key) => escapeCsv(row[key])).join(','));
    return [header.join(','), ...lines].join('\n');
}

async function listAdminRouters(filters = {}) {
    const related = await loadRouterDirectoryData();
    const searchTerm = String(filters.q || '').trim().toLowerCase();
    const createdFrom = toDateOrNull(filters.createdFrom);
    const createdTo = toDateOrNull(filters.createdTo);
    const lastSeenFrom = toDateOrNull(filters.lastSeenFrom);
    const lastSeenTo = toDateOrNull(filters.lastSeenTo);

    let rows = related.routers.map((router) => buildRouterListItem(router, related));
    rows = rows.filter((row) => {
        if (searchTerm) {
            const haystack = [
                row.id,
                row.name,
                row.customer?.name,
                row.customer?.email,
                row.vpnIp,
                row.serverNode,
                row.winboxPort,
                row.sshPort,
                row.apiPort,
                row.location
            ].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(searchTerm)) return false;
        }
        if (filters.status && row.status !== filters.status) return false;
        if (filters.setupStatus && row.setupStatus !== filters.setupStatus) return false;
        if (filters.connectionStatus && row.connectionStatus !== filters.connectionStatus) return false;
        if (filters.serverNode && row.serverNode !== filters.serverNode) return false;
        if (filters.ownerId && row.customer?.id !== String(filters.ownerId)) return false;
        if (filters.billingState && row.billingState !== filters.billingState) return false;
        if (filters.portsState === 'missing' && row.winboxPort && row.sshPort && row.apiPort) return false;
        if (filters.portsState === 'assigned' && (!row.winboxPort || !row.sshPort || !row.apiPort)) return false;
        if (filters.handshakeState && (row.lastHandshake ? (((Date.now() - new Date(row.lastHandshake).getTime()) > 180000) ? 'stale' : 'fresh') : 'none') !== filters.handshakeState) return false;
        if (filters.recentlyOffline === 'true' && row.connectionStatus !== 'offline') return false;
        if (filters.unhealthyState === 'true' && !row.unhealthy) return false;
        if (filters.flaggedState === 'true' && row.issueFlags.length === 0) return false;
        if (!matchDateRange(row.createdAt, createdFrom, createdTo)) return false;
        if (!matchDateRange(row.lastSeen, lastSeenFrom, lastSeenTo)) return false;
        return true;
    });

    const sortBy = filters.sortBy || 'createdAt';
    const direction = filters.sortOrder === 'asc' ? 1 : -1;
    rows = rows.sort((a, b) => {
        const aValue = getSortValue(a, sortBy);
        const bValue = getSortValue(b, sortBy);
        if (aValue < bValue) return -1 * direction;
        if (aValue > bValue) return 1 * direction;
        return 0;
    });

    if (String(filters.format || '').toLowerCase() === 'csv') {
        return {
            format: 'csv',
            csv: serializeRoutersAsCsv(rows),
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

async function getAdminRouterStats() {
    const related = await loadRouterDirectoryData();
    const items = related.routers.map((router) => buildRouterListItem(router, related));
    const byServerNode = items.reduce((acc, item) => {
        const key = item.serverNode || 'wireguard';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    return {
        totalRouters: items.length,
        onlineRouters: items.filter((item) => item.connectionStatus === 'online').length,
        offlineRouters: items.filter((item) => item.connectionStatus === 'offline').length,
        pendingSetupRouters: items.filter((item) => ['pending', 'awaiting_connection'].includes(item.setupStatus)).length,
        failedProvisioningRouters: items.filter((item) => item.setupStatus === 'failed').length,
        routersWithoutPorts: items.filter((item) => !item.winboxPort || !item.sshPort || !item.apiPort).length,
        routersWithUnhealthyTunnelState: items.filter((item) => item.unhealthy).length,
        routersByServerNode: byServerNode,
        routersWithActiveAlerts: items.filter((item) => item.issueFlags.length > 0 || item.unhealthy).length
    };
}

async function getRouterBundle(routerId) {
    const router = await MikrotikRouter.findById(routerId)
        .populate('userId')
        .populate('wireguardClientId');
    if (!router) return null;

    const [subscription, transactions, ownerRouters, auditLogs] = await Promise.all([
        Subscription.findOne({ routerId: router._id }).lean(),
        Transaction.find({ routerId: router._id }).sort({ createdAt: -1 }).lean(),
        MikrotikRouter.find({ userId: router.userId?._id || router.userId }).lean(),
        AdminAuditLog.find({ targetRouterId: router._id }).populate('actorUserId', 'name email').sort({ createdAt: -1 }).lean()
    ]);

    return {
        router,
        client: router.wireguardClientId || null,
        owner: router.userId || null,
        subscription,
        transactions,
        ownerRouters,
        auditLogs
    };
}

function formatAuditEvent(entry) {
    return {
        id: String(entry._id),
        type: 'admin_action',
        source: 'admin',
        actor: entry.actorUserId?.email || entry.actorUserId?.name || 'admin',
        action: entry.action,
        summary: entry.reason ? `${entry.action}: ${entry.reason}` : entry.action,
        metadata: entry.metadata || {},
        timestamp: entry.createdAt
    };
}

function buildRouterActivity(bundle) {
    const { router, client, subscription, transactions, auditLogs } = bundle;
    const events = [
        {
            id: `router-created-${router._id}`,
            type: 'router_created',
            source: 'system',
            actor: bundle.owner?.email || 'system',
            summary: 'Router created',
            metadata: { routerId: String(router._id), vpnIp: router.vpnIp },
            timestamp: router.createdAt
        }
    ];

    if (client) {
        events.push({
            id: `peer-provisioned-${client._id}`,
            type: 'peer_provisioned',
            source: 'wireguard',
            actor: 'system',
            summary: 'WireGuard peer provisioned',
            metadata: { clientId: String(client._id), peer: client.name, vpnIp: client.ip },
            timestamp: client.createdAt
        });
    }

    if (router.lastSetupGeneratedAt) {
        events.push({
            id: `setup-generated-${router._id}`,
            type: 'setup_generated',
            source: 'provisioning',
            actor: 'system',
            summary: 'Setup/config generated',
            metadata: { generatedAt: router.lastSetupGeneratedAt },
            timestamp: router.lastSetupGeneratedAt
        });
    }

    if (router.firstConnectedAt) {
        events.push({
            id: `first-connected-${router._id}`,
            type: 'tunnel_connected',
            source: 'monitoring',
            actor: 'system',
            summary: 'Router first connected',
            metadata: { firstConnectedAt: router.firstConnectedAt },
            timestamp: router.firstConnectedAt
        });
    }

    if (router.lastSeen) {
        events.push({
            id: `last-seen-${router._id}`,
            type: router.status === 'active' ? 'status_online' : 'status_changed',
            source: 'monitoring',
            actor: 'system',
            summary: `Router status is ${router.status}`,
            metadata: { lastSeen: router.lastSeen, status: router.status },
            timestamp: router.lastSeen
        });
    }

    if (subscription) {
        events.push({
            id: `subscription-${subscription._id}`,
            type: 'subscription_linked',
            source: 'billing',
            actor: 'billing',
            summary: `Subscription ${subscription.status}`,
            metadata: normalizeSubscription(subscription),
            timestamp: subscription.createdAt || subscription.updatedAt
        });
    }

    transactions.forEach((transaction) => {
        events.push({
            id: `transaction-${transaction._id}`,
            type: transaction.status === 'failed' ? 'payment_failed' : 'payment_event',
            source: 'billing',
            actor: 'billing',
            summary: `${transaction.type} ${transaction.status}`,
            metadata: {
                amount: transaction.amount,
                currency: transaction.currency,
                paymentMethod: transaction.paymentMethod
            },
            timestamp: transaction.createdAt
        });
    });

    auditLogs.forEach((entry) => {
        events.push(formatAuditEvent(entry));
    });

    return events.filter((item) => Boolean(item.timestamp)).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function buildProvisioningSummary(bundle) {
    const { router, client } = bundle;
    return {
        state: deriveSetupStatus(router, client),
        configGenerationStatus: client ? 'available' : 'missing_peer',
        provisioningError: router.provisioningError || null,
        assignedResources: {
            vpnIp: router.vpnIp,
            serverNode: router.serverNode || 'wireguard',
            ports: router.ports
        },
        timestamps: {
            createdAt: router.createdAt,
            setupGeneratedAt: router.lastSetupGeneratedAt || client?.createdAt || null,
            firstConnectedAt: router.firstConnectedAt || null,
            lastReconfiguredAt: router.lastReconfiguredAt || null,
            provisioningReviewedAt: router.provisioningReviewedAt || null
        }
    };
}

function buildDiagnostics(bundle) {
    const { router, client, subscription } = bundle;
    const proxyStatus = getProxyStatus(router._id);
    const issues = [];

    if (!client) issues.push({ code: 'missing_peer', severity: 'critical', message: 'Router does not have a linked WireGuard client.' });
    if (client && router.vpnIp !== client.ip) issues.push({ code: 'vpn_ip_mismatch', severity: 'critical', message: 'Router VPN IP does not match linked WireGuard client IP.' });
    if (!router.ports?.winbox || !router.ports?.ssh || !router.ports?.api) issues.push({ code: 'missing_ports', severity: 'critical', message: 'Router is missing one or more public access ports.' });
    if (client && !client.enabled) issues.push({ code: 'peer_disabled', severity: 'warning', message: 'Linked WireGuard peer is disabled.' });
    if (router.status === 'offline') issues.push({ code: 'router_offline', severity: 'warning', message: 'Router is marked offline.' });
    if (getHandshakeState(client) === 'never') issues.push({ code: 'no_handshake', severity: 'warning', message: 'Router has not reported a WireGuard handshake yet.' });
    if (getHandshakeState(client) === 'stale') issues.push({ code: 'stale_handshake', severity: 'warning', message: 'Router handshake is stale.' });
    if (router.status !== 'inactive' && !proxyStatus.running) issues.push({ code: 'proxy_not_running', severity: 'warning', message: 'Router TCP proxy is not currently running.' });
    if (!subscription) issues.push({ code: 'missing_subscription', severity: 'warning', message: 'Router does not have an associated subscription.' });
    if (router.provisioningError) issues.push({ code: 'provisioning_error', severity: 'critical', message: router.provisioningError });

    return {
        status: issues.some((issue) => issue.severity === 'critical') ? 'critical' : (issues.length ? 'warning' : 'healthy'),
        issues,
        proxyStatus,
        recommendedActions: [
            issues.some((issue) => issue.code === 'missing_ports') ? 'reassign_ports' : null,
            issues.some((issue) => issue.code === 'missing_peer') ? 'reprovision' : null,
            issues.some((issue) => issue.code === 'stale_handshake') ? 'reset_peer' : null,
            issues.some((issue) => issue.code === 'proxy_not_running') ? 'reactivate' : null
        ].filter(Boolean)
    };
}

async function getAdminRouterDetail(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;

    const { router, client, owner, subscription, ownerRouters } = bundle;
    const monitoring = buildMonitoringSummary(router, client);
    const activity = buildRouterActivity(bundle);

    return {
        id: String(router._id),
        profile: {
            id: String(router._id),
            name: router.name,
            vpnIp: router.vpnIp,
            serverNode: router.serverNode || 'wireguard',
            status: router.status,
            setupStatus: deriveSetupStatus(router, client),
            connectionStatus: deriveConnectionStatus(router, client),
            createdAt: router.createdAt,
            updatedAt: router.updatedAt
        },
        customer: owner ? buildCustomerSummary(owner, ownerRouters.length, null, subscription) : null,
        accessPorts: buildPortsSummary(router),
        connectivity: buildConnectivitySummary(router, client),
        monitoring,
        provisioning: buildProvisioningSummary(bundle),
        billing: {
            subscription: normalizeSubscription(subscription),
            transactionsPreview: bundle.transactions.slice(0, 10)
        },
        issues: buildDiagnostics(bundle),
        recentActivity: activity.slice(0, 10),
        notes: (router.adminNotes || []).map(normalizeRouterNote),
        flags: (router.internalFlags || []).map(normalizeRouterFlag)
    };
}

async function getAdminRouterConnectivity(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildConnectivitySummary(bundle.router, bundle.client);
}

async function getAdminRouterPorts(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildPortsSummary(bundle.router);
}

async function getAdminRouterMonitoring(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildMonitoringSummary(bundle.router, bundle.client);
}

async function getAdminRouterActivity(routerId, filters = {}) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    let items = buildRouterActivity(bundle);
    const from = toDateOrNull(filters.from);
    const to = toDateOrNull(filters.to);

    if (filters.type) items = items.filter((item) => item.type === filters.type);
    if (filters.source) items = items.filter((item) => item.source === filters.source);
    if (filters.actor) {
        const actor = String(filters.actor).toLowerCase();
        items = items.filter((item) => String(item.actor || '').toLowerCase().includes(actor));
    }
    if (from || to) {
        items = items.filter((item) => matchDateRange(item.timestamp, from, to));
    }

    return paginate(items, filters.page, filters.limit);
}

async function getAdminRouterProvisioning(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildProvisioningSummary(bundle);
}

async function getAdminRouterDiagnostics(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildDiagnostics(bundle);
}

async function getAdminRouterNotes(routerId) {
    const router = await MikrotikRouter.findById(routerId).select('adminNotes');
    if (!router) return null;
    return (router.adminNotes || []).map(normalizeRouterNote).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getAdminRouterFlags(routerId) {
    const router = await MikrotikRouter.findById(routerId).select('internalFlags');
    if (!router) return null;
    return (router.internalFlags || []).map(normalizeRouterFlag).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function buildWireGuardConfig(client, serverPublicKey, serverEndpoint) {
    const keepalive = validateKeepalive(client.persistentKeepalive || KEEPALIVE_TIME);
    const allowedIPs = client.allowedIPs || '10.0.0.0/24';
    return `[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.ip}

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverEndpoint}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = ${keepalive}`;
}

function buildMikrotikSetupScript(client, serverPublicKey, serverEndpoint, routerName) {
    const serverEndpointParts = serverEndpoint.split(':');
    const serverHost = serverEndpointParts[0];
    const serverPort = serverEndpointParts[1] || '51820';
    const ifaceName = (client.interfaceName || `wireguard-${routerName}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    const allowed = client.allowedIPs || '10.0.0.0/24';
    const keepalive = validateKeepalive(client.persistentKeepalive || KEEPALIVE_TIME);

    return `:local IFACE "${ifaceName}";:local PRIV "${client.privateKey}";:local IP "${client.ip}";:local SPK "${serverPublicKey}";:local HOST "${serverHost}";:local PORT "${serverPort}";:local ALLOW "${allowed}";:local LP 51810;:for i from=0 to=32 do={:local T ($LP+$i);:if ([/interface wireguard print count-only where listen-port=$T]=0) do={:set LP $T;:set i 33}};:if ([/interface wireguard print count-only where name=$IFACE]=0) do={/interface wireguard add name=$IFACE};/interface wireguard set [find where name=$IFACE] private-key=$PRIV listen-port=$LP;/interface wireguard enable [find where name=$IFACE];:if ([/ip address print count-only where address=$IP]=0) do={/ip address add address=$IP interface=$IFACE disabled=no};:local PID [/interface wireguard peers find where interface=$IFACE public-key=$SPK];:if ([:len $PID]=0) do={/interface wireguard peers add interface=$IFACE public-key=$SPK endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}} else={/interface wireguard peers set $PID endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}};:if ([/ip route print count-only where dst-address=$ALLOW gateway=$IFACE]=0) do={/ip route add dst-address=$ALLOW gateway=$IFACE disabled=no};:delay 2;:local ok 0;:do {/ping 10.0.0.1 count=3;:set ok 1} on-error={:set ok 0};:if ($ok=1) do={:put "OK ${routerName} $IFACE $IP $LP"} else={:put "FAIL ${routerName}"}`;
}

async function generateRouterSetupArtifacts(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router, client } = bundle;
    if (!client) {
        throw new Error('Router does not have a linked WireGuard client');
    }

    const serverPublicKey = (await getServerPublicKey()).trim();
    const serverEndpoint = client.endpoint || getServerEndpoint();

    router.lastSetupGeneratedAt = new Date();
    await router.save();

    return {
        routerId: String(router._id),
        generatedAt: router.lastSetupGeneratedAt,
        wireguardConfig: buildWireGuardConfig(client, serverPublicKey, serverEndpoint),
        mikrotikScript: buildMikrotikSetupScript(client, serverPublicKey, serverEndpoint, router.name),
        connectivity: buildConnectivitySummary(router, client)
    };
}

async function ensureRouterHasPorts(router) {
    if (router.ports?.winbox && router.ports?.ssh && router.ports?.api) {
        return router.ports;
    }

    const ports = await allocatePorts();
    router.ports = ports;
    return ports;
}

async function ensureRouterHasClient(router, dbInitialized = true) {
    if (router.wireguardClientId) {
        const client = await Client.findById(router.wireguardClientId);
        if (client) return client;
    }

    const ownerId = router.userId?._id || router.userId;
    const { privateKey, publicKey } = await generateKeys();
    const allocatedIp = router.vpnIp || await getNextAvailableIP(dbInitialized);
    const client = await Client.create({
        name: `router-${router.name.toLowerCase()}-${String(ownerId)}`,
        ip: allocatedIp,
        publicKey,
        privateKey,
        enabled: true,
        notes: `MikroTik router: ${router.name}`,
        createdBy: String(ownerId)
    });

    router.wireguardClientId = client._id;
    router.vpnIp = client.ip;
    return client;
}

async function attachPeerToWireGuard(client) {
    const keepalive = validateKeepalive(client.persistentKeepalive || KEEPALIVE_TIME);
    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'allowed-ips', client.ip, 'persistent-keepalive', String(keepalive)]));
}

async function detachPeerFromWireGuard(client) {
    if (!client?.publicKey) return;
    try {
        await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
    } catch (error) {
        // Ignore missing peers; admin action should still proceed.
    }
}

async function disableRouter(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router, client } = bundle;

    if (client) {
        client.enabled = false;
        await client.save();
        await detachPeerFromWireGuard(client);
    }

    stopRouterProxy(router._id);
    router.status = 'inactive';
    router.lastReconfiguredAt = new Date();
    router.provisioningError = '';
    await router.save();

    return bundle;
}

async function reactivateRouter(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router } = bundle;
    const client = bundle.client || await ensureRouterHasClient(router);

    client.enabled = true;
    await client.save();
    await attachPeerToWireGuard(client);

    router.status = 'pending';
    router.lastReconfiguredAt = new Date();
    router.provisioningError = '';
    await router.save();
    await restartRouterProxy(router._id);

    return getRouterBundle(routerId);
}

async function resetRouterPeer(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router } = bundle;
    const client = bundle.client || await ensureRouterHasClient(router);

    await detachPeerFromWireGuard(client);
    const { privateKey, publicKey } = await generateKeys();
    client.privateKey = privateKey;
    client.publicKey = publicKey;
    client.enabled = true;
    await client.save();
    await attachPeerToWireGuard(client);

    router.status = 'pending';
    router.lastReconfiguredAt = new Date();
    router.lastSetupGeneratedAt = new Date();
    router.provisioningError = '';
    await router.save();

    return generateRouterSetupArtifacts(routerId);
}

async function reprovisionRouter(routerId, options = {}) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router } = bundle;

    const client = bundle.client || await ensureRouterHasClient(router, options.dbInitialized !== false);
    await ensureRouterHasPorts(router);
    client.enabled = true;
    await client.save();
    await attachPeerToWireGuard(client);

    router.status = 'pending';
    router.lastReconfiguredAt = new Date();
    router.lastSetupGeneratedAt = new Date();
    router.provisioningError = '';
    await router.save();

    await restartRouterProxy(router._id);

    return getRouterBundle(routerId);
}

async function isPortAvailable(routerId, portType, port) {
    const existing = await MikrotikRouter.findOne({
        _id: { $ne: routerId },
        [`ports.${portType}`]: port
    }).lean();

    return !existing;
}

async function reassignRouterPorts(routerId, requestedPorts = null) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router } = bundle;
    const oldPorts = { ...router.ports };
    let newPorts;

    if (requestedPorts) {
        const nextPorts = {
            winbox: Number(requestedPorts.winbox),
            ssh: Number(requestedPorts.ssh),
            api: Number(requestedPorts.api)
        };
        const valid = Number.isInteger(nextPorts.winbox) && Number.isInteger(nextPorts.ssh) && Number.isInteger(nextPorts.api);
        if (!valid) {
            throw new Error('All requested ports must be integers');
        }
        const [winboxFree, sshFree, apiFree] = await Promise.all([
            isPortAvailable(router._id, 'winbox', nextPorts.winbox),
            isPortAvailable(router._id, 'ssh', nextPorts.ssh),
            isPortAvailable(router._id, 'api', nextPorts.api)
        ]);
        if (!winboxFree || !sshFree || !apiFree) {
            throw new Error('One or more requested ports are already assigned');
        }
        newPorts = nextPorts;
    } else {
        newPorts = await allocatePorts();
    }

    router.ports = newPorts;
    router.lastReconfiguredAt = new Date();
    await router.save();
    await restartRouterProxy(router._id);

    return {
        routerId: String(router._id),
        oldPorts,
        newPorts
    };
}

async function markRouterProvisioningReviewed(routerId, reviewerEmail) {
    const router = await MikrotikRouter.findById(routerId);
    if (!router) return null;

    router.provisioningReviewedAt = new Date();
    router.provisioningReviewedBy = reviewerEmail;
    await router.save();
    return router;
}

async function deleteRouterAdmin(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const { router, client } = bundle;

    const owner = router.userId || bundle.owner || null;
    const routerInfo = {
        name: router.name,
        ports: router.ports
    };

    if (client) {
        await detachPeerFromWireGuard(client);
        await Client.findByIdAndDelete(client._id);
    }

    stopRouterProxy(router._id);
    await releasePorts(router._id);

    await router.deleteOne();

    if (owner) {
        try {
            await sendRouterDeletedEmail(owner, routerInfo);
        } catch (error) {
            // Ignore notification failure so deletion completes consistently.
        }
    }

    return {
        routerId,
        routerName: router.name
    };
}

module.exports = {
    ADMIN_ROUTER_PERMISSIONS,
    ROUTER_NOTE_CATEGORIES,
    ROUTER_FLAG_TYPES,
    ROUTER_FLAG_SEVERITIES,
    listAdminRouters,
    getAdminRouterStats,
    getAdminRouterDetail,
    getAdminRouterConnectivity,
    getAdminRouterPorts,
    getAdminRouterMonitoring,
    getAdminRouterActivity,
    getAdminRouterProvisioning,
    getAdminRouterDiagnostics,
    getAdminRouterNotes,
    getAdminRouterFlags,
    generateRouterSetupArtifacts,
    disableRouter,
    reactivateRouter,
    resetRouterPeer,
    reprovisionRouter,
    reassignRouterPorts,
    markRouterProvisioningReviewed,
    deleteRouterAdmin
};
