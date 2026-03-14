const VpnServer = require('../models/VpnServer');
const MikrotikRouter = require('../models/MikrotikRouter');
const Client = require('../models/Client');
const AdminAuditLog = require('../models/AdminAuditLog');
const {
    LOCAL_NODE_ID,
    ensureLocalVpnServer,
    getLocalRuntimeMetrics,
    syncLocalServerHealth,
    restartLocalWireGuard,
    reconcileLocalWireGuard
} = require('./vpn-infrastructure-service');

const VPN_SERVER_NOTE_CATEGORIES = ['infrastructure', 'capacity', 'maintenance', 'migration', 'monitoring', 'incident', 'follow_up'];
const VPN_SERVER_FLAG_TYPES = ['overloaded', 'unhealthy', 'under_maintenance', 'migration_blocked', 'manual_review', 'degraded'];
const VPN_SERVER_FLAG_SEVERITIES = ['low', 'medium', 'high'];
const ADMIN_VPN_SERVER_PERMISSIONS = {
    VIEW: 'admin.vpn_servers.view',
    VIEW_DETAILS: 'admin.vpn_servers.view_details',
    VIEW_HEALTH: 'admin.vpn_servers.view_health',
    VIEW_PEERS: 'admin.vpn_servers.view_peers',
    MANAGE_STATUS: 'admin.vpn_servers.manage_status',
    ADD: 'admin.vpn_servers.add',
    DISABLE: 'admin.vpn_servers.disable',
    MAINTENANCE: 'admin.vpn_servers.maintenance',
    MIGRATE_ROUTERS: 'admin.vpn_servers.migrate_routers',
    RESTART_VPN: 'admin.vpn_servers.restart_vpn',
    ADD_NOTE: 'admin.vpn_servers.add_note',
    FLAG: 'admin.vpn_servers.flag'
};

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeServerNote(note) {
    return {
        id: String(note._id),
        body: note.body,
        category: note.category || 'infrastructure',
        pinned: Boolean(note.pinned),
        author: note.author || 'system',
        createdAt: note.createdAt
    };
}

function normalizeServerFlag(flag) {
    return {
        id: String(flag._id),
        flag: flag.flag,
        severity: flag.severity || 'medium',
        description: flag.description || '',
        createdBy: flag.createdBy || 'system',
        createdAt: flag.createdAt
    };
}

async function getServerBundle(serverId) {
    await ensureLocalVpnServer();
    const server = await VpnServer.findById(serverId);
    if (!server) return null;

    const routers = await MikrotikRouter.find({ serverNode: server.nodeId }).populate('userId', 'name email').populate('wireguardClientId').lean();
    const routerIds = routers.map((router) => router._id);
    const peerIds = routers.map((router) => router.wireguardClientId?._id).filter(Boolean);
    const standalonePeers = server.nodeId === LOCAL_NODE_ID
        ? await Client.find({ _id: { $nin: peerIds } }).lean()
        : [];
    const auditLogs = await AdminAuditLog.find({ targetServerId: server._id }).populate('actorUserId', 'name email').sort({ createdAt: -1 }).lean();

    let runtime = null;
    if (server.nodeId === LOCAL_NODE_ID) {
        runtime = await syncLocalServerHealth(server);
    }

    return {
        server,
        routers,
        standalonePeers,
        auditLogs,
        runtime
    };
}

function buildCapacitySummary(server, runtime, routers) {
    const peerCount = runtime?.totalPeerCount || routers.length;
    const routerCount = routers.length;
    const peerCapacity = server.maxPeers || null;
    const routerCapacity = server.maxRouters || null;
    const peerUtilization = peerCapacity ? Number(((peerCount / peerCapacity) * 100).toFixed(2)) : null;
    const routerUtilization = routerCapacity ? Number(((routerCount / routerCapacity) * 100).toFixed(2)) : null;

    return {
        peerCount,
        activePeerCount: runtime?.activePeerCount || 0,
        routerCount,
        onlineRouters: runtime?.onlineRouters || routers.filter((router) => router.status === 'active').length,
        offlineRouters: runtime?.offlineRouters || routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length,
        maxPeers: peerCapacity,
        maxRouters: routerCapacity,
        peerUtilization,
        routerUtilization,
        overloaded: Boolean((peerUtilization && peerUtilization >= 90) || (routerUtilization && routerUtilization >= 90)),
        nearCapacity: Boolean((peerUtilization && peerUtilization >= 75) || (routerUtilization && routerUtilization >= 75))
    };
}

function buildHealthSummary(server, runtime, routers) {
    const capacity = buildCapacitySummary(server, runtime, routers);
    const staleTelemetry = runtime ? !runtime.interfaceUp || runtime.stalePeers > 0 : true;
    const issues = [];

    if (!server.enabled) issues.push('server_disabled');
    if (server.maintenanceMode) issues.push('maintenance_mode');
    if (runtime?.error) issues.push('wireguard_runtime_error');
    if (runtime && !runtime.interfaceUp) issues.push('interface_down');
    if (runtime?.stalePeers) issues.push('stale_peers');
    if (capacity.overloaded) issues.push('overloaded');
    if (server.internalFlags?.length) issues.push('flagged');

    return {
        status: !server.enabled ? 'disabled' : (server.maintenanceMode ? 'maintenance' : (issues.length ? 'degraded' : 'healthy')),
        staleTelemetry,
        issues,
        lastHeartbeatAt: server.lastHeartbeatAt || null,
        lastHealthCheckAt: server.lastHealthCheckAt || null,
        load: capacity
    };
}

function buildTrafficSummary(runtime) {
    return {
        totalTransferRx: runtime?.totalTransferRx || 0,
        totalTransferTx: runtime?.totalTransferTx || 0,
        totalTransferBytes: (runtime?.totalTransferRx || 0) + (runtime?.totalTransferTx || 0),
        activePeerCount: runtime?.activePeerCount || 0,
        totalPeerCount: runtime?.totalPeerCount || 0
    };
}

function buildServerListItem(server, runtime, routers) {
    const health = buildHealthSummary(server, runtime, routers);
    const traffic = buildTrafficSummary(runtime);
    return {
        id: String(server._id),
        nodeId: server.nodeId,
        name: server.name,
        region: server.region || 'unknown',
        hostname: server.hostname || null,
        endpoint: server.endpoint || null,
        status: server.status,
        enabled: server.enabled,
        maintenanceMode: server.maintenanceMode,
        healthSummary: health,
        activePeerCount: traffic.activePeerCount,
        routerCount: routers.length,
        onlineRouterCount: routers.filter((router) => router.status === 'active').length,
        offlineRouterCount: routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length,
        bandwidthSummary: traffic,
        loadCapacitySummary: health.load,
        lastHeartbeatAt: server.lastHeartbeatAt || null,
        createdAt: server.createdAt,
        issueFlags: (server.internalFlags || []).map((flag) => flag.flag)
    };
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

function getSortValue(item, sortBy) {
    switch (sortBy) {
        case 'name':
        case 'nodeId':
        case 'region':
        case 'status':
            return String(item[sortBy] || '').toLowerCase();
        case 'activePeerCount':
        case 'routerCount':
        case 'onlineRouterCount':
        case 'offlineRouterCount':
            return Number(item[sortBy] || 0);
        case 'lastHeartbeatAt':
        case 'createdAt':
            return item[sortBy] ? new Date(item[sortBy]).getTime() : 0;
        default:
            return item.createdAt ? new Date(item.createdAt).getTime() : 0;
    }
}

async function listAdminVpnServers(filters = {}) {
    const localServer = await ensureLocalVpnServer();
    const servers = await VpnServer.find({}).sort({ createdAt: -1 });
    const bundles = [];

    for (const server of servers) {
        const routers = await MikrotikRouter.find({ serverNode: server.nodeId }).lean();
        const runtime = server.nodeId === LOCAL_NODE_ID ? await syncLocalServerHealth(server) : null;
        bundles.push(buildServerListItem(server, runtime, routers));
    }

    let items = bundles;
    const query = String(filters.q || '').trim().toLowerCase();
    const createdFrom = toDateOrNull(filters.createdFrom);
    const createdTo = toDateOrNull(filters.createdTo);

    items = items.filter((item) => {
        if (query) {
            const haystack = [item.name, item.nodeId, item.hostname, item.endpoint, item.region, item.status].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        if (filters.enabled === 'true' && !item.enabled) return false;
        if (filters.enabled === 'false' && item.enabled) return false;
        if (filters.status && item.status !== filters.status) return false;
        if (filters.healthStatus && item.healthSummary.status !== filters.healthStatus) return false;
        if (filters.maintenanceMode === 'true' && !item.maintenanceMode) return false;
        if (filters.maintenanceMode === 'false' && item.maintenanceMode) return false;
        if (filters.overloaded === 'true' && !item.loadCapacitySummary.overloaded) return false;
        if (filters.region && item.region !== filters.region) return false;
        if (filters.hasIncidents === 'true' && item.issueFlags.length === 0) return false;
        if (createdFrom || createdTo) {
            const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
            if (createdFrom && createdAt < createdFrom.getTime()) return false;
            if (createdTo && createdAt > createdTo.getTime()) return false;
        }
        return true;
    });

    const sortBy = filters.sortBy || 'createdAt';
    const direction = filters.sortOrder === 'asc' ? 1 : -1;
    items = items.sort((a, b) => {
        const aValue = getSortValue(a, sortBy);
        const bValue = getSortValue(b, sortBy);
        if (aValue < bValue) return -1 * direction;
        if (aValue > bValue) return 1 * direction;
        return 0;
    });

    return paginate(items, filters.page, filters.limit);
}

async function getAdminVpnServerStats() {
    const directory = await listAdminVpnServers({ page: 1, limit: 1000 });
    const items = directory.items;
    return {
        totalServers: items.length,
        healthyServers: items.filter((item) => item.healthSummary.status === 'healthy').length,
        unhealthyServers: items.filter((item) => item.healthSummary.status === 'degraded').length,
        disabledServers: items.filter((item) => !item.enabled).length,
        maintenanceServers: items.filter((item) => item.maintenanceMode).length,
        overloadedServers: items.filter((item) => item.loadCapacitySummary.overloaded).length,
        totalPeers: items.reduce((sum, item) => sum + (item.activePeerCount || 0), 0),
        totalRoutersAttached: items.reduce((sum, item) => sum + (item.routerCount || 0), 0),
        serversWithIncidents: items.filter((item) => item.issueFlags.length > 0).length,
        serversWithStaleTelemetry: items.filter((item) => item.healthSummary.staleTelemetry).length
    };
}

async function getAdminVpnServerDetail(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;

    const health = buildHealthSummary(bundle.server, bundle.runtime, bundle.routers);
    const traffic = buildTrafficSummary(bundle.runtime);
    const activity = buildVpnServerActivity(bundle);

    return {
        id: String(bundle.server._id),
        profile: {
            id: String(bundle.server._id),
            nodeId: bundle.server.nodeId,
            name: bundle.server.name,
            region: bundle.server.region || 'unknown',
            hostname: bundle.server.hostname || null,
            endpoint: bundle.server.endpoint || null,
            controlMode: bundle.server.controlMode,
            status: bundle.server.status,
            enabled: bundle.server.enabled,
            maintenanceMode: bundle.server.maintenanceMode,
            createdAt: bundle.server.createdAt,
            updatedAt: bundle.server.updatedAt
        },
        health,
        loadCapacity: health.load,
        traffic,
        attachedRoutersCount: bundle.routers.length,
        attachedPeersCount: bundle.runtime?.totalPeerCount || bundle.routers.length,
        onlineRoutersCount: bundle.routers.filter((router) => router.status === 'active').length,
        offlineRoutersCount: bundle.routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length,
        recentActivity: activity.slice(0, 15),
        recentIssues: buildVpnServerDiagnostics(bundle).issues.slice(0, 10),
        lastHeartbeatAt: bundle.server.lastHeartbeatAt || null,
        notes: (bundle.server.adminNotes || []).map(normalizeServerNote),
        flags: (bundle.server.internalFlags || []).map(normalizeServerFlag)
    };
}

async function getAdminVpnServerHealth(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    return buildHealthSummary(bundle.server, bundle.runtime, bundle.routers);
}

async function getAdminVpnServerRouters(serverId, filters = {}) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    let items = bundle.routers.map((router) => ({
        id: String(router._id),
        name: router.name,
        customer: router.userId ? { id: String(router.userId._id), name: router.userId.name, email: router.userId.email } : null,
        status: router.status,
        vpnIp: router.vpnIp,
        lastSeen: router.lastSeen || null,
        lastHandshake: router.wireguardClientId?.lastHandshake || null,
        publicPorts: router.ports,
        provisioningState: router.firstConnectedAt ? 'connected' : 'awaiting_connection'
    }));

    if (filters.q) {
        const query = String(filters.q).toLowerCase();
        items = items.filter((item) => [item.name, item.customer?.name, item.customer?.email, item.vpnIp].filter(Boolean).join(' ').toLowerCase().includes(query));
    }
    if (filters.status) items = items.filter((item) => item.status === filters.status);

    return paginate(items, filters.page, filters.limit);
}

async function getAdminVpnServerPeers(serverId, filters = {}) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;

    let peers = bundle.server.nodeId === LOCAL_NODE_ID
        ? await Client.find({}).lean()
        : bundle.routers.map((router) => router.wireguardClientId).filter(Boolean);

    const routerByClientId = new Map(bundle.routers.filter((router) => router.wireguardClientId?._id).map((router) => [String(router.wireguardClientId._id), router]));
    const items = peers.map((peer) => {
        const linkedRouter = routerByClientId.get(String(peer._id));
        return {
            id: String(peer._id),
            reference: peer.name,
            enabled: peer.enabled,
            health: peer.lastHandshake && (Date.now() - new Date(peer.lastHandshake).getTime()) <= 180000 ? 'healthy' : 'stale',
            transferRx: peer.transferRx || 0,
            transferTx: peer.transferTx || 0,
            lastHandshake: peer.lastHandshake || null,
            router: linkedRouter ? { id: String(linkedRouter._id), name: linkedRouter.name, vpnIp: linkedRouter.vpnIp } : null
        };
    });

    return paginate(items, filters.page, filters.limit);
}

async function getAdminVpnServerTraffic(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    return buildTrafficSummary(bundle.runtime);
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

function buildVpnServerActivity(bundle) {
    const events = [{
        id: `server-created-${bundle.server._id}`,
        type: 'server_created',
        source: 'system',
        actor: 'system',
        summary: 'VPN server record created',
        metadata: { nodeId: bundle.server.nodeId, controlMode: bundle.server.controlMode },
        timestamp: bundle.server.createdAt
    }];

    if (bundle.server.lastRestartAt) {
        events.push({
            id: `server-restarted-${bundle.server._id}`,
            type: 'vpn_restarted',
            source: 'infrastructure',
            actor: 'system',
            summary: 'WireGuard service restarted',
            metadata: { lastRestartAt: bundle.server.lastRestartAt },
            timestamp: bundle.server.lastRestartAt
        });
    }

    if (bundle.server.lastReconcileAt) {
        events.push({
            id: `server-reconciled-${bundle.server._id}`,
            type: 'reconciled',
            source: 'infrastructure',
            actor: 'system',
            summary: 'WireGuard peers reconciled',
            metadata: { lastReconcileAt: bundle.server.lastReconcileAt },
            timestamp: bundle.server.lastReconcileAt
        });
    }

    if (bundle.server.lastHealthCheckAt) {
        events.push({
            id: `server-health-${bundle.server._id}`,
            type: 'health_checked',
            source: 'monitoring',
            actor: 'system',
            summary: `Health check completed (${bundle.server.status})`,
            metadata: { status: bundle.server.status },
            timestamp: bundle.server.lastHealthCheckAt
        });
    }

    bundle.auditLogs.forEach((entry) => {
        events.push(formatAuditEvent(entry));
    });

    return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function buildVpnServerDiagnostics(bundle) {
    const health = buildHealthSummary(bundle.server, bundle.runtime, bundle.routers);
    const issues = [];

    if (!bundle.server.enabled && bundle.routers.length > 0) {
        issues.push({ code: 'disabled_with_assignments', severity: 'critical', message: 'Disabled server still has assigned routers.' });
    }
    if (bundle.server.maintenanceMode && bundle.routers.some((router) => router.status === 'active')) {
        issues.push({ code: 'maintenance_with_active_routers', severity: 'warning', message: 'Server is in maintenance mode with active routers still attached.' });
    }
    if (bundle.runtime?.error) {
        issues.push({ code: 'wireguard_runtime_error', severity: 'critical', message: bundle.runtime.error });
    }
    if (bundle.runtime && !bundle.runtime.interfaceUp) {
        issues.push({ code: 'interface_down', severity: 'critical', message: 'WireGuard interface is not running.' });
    }
    if (bundle.runtime?.stalePeers) {
        issues.push({ code: 'stale_peers', severity: 'warning', message: `${bundle.runtime.stalePeers} peers have stale or missing handshakes.` });
    }
    if (health.load.overloaded) {
        issues.push({ code: 'overloaded', severity: 'warning', message: 'Server is near or above configured capacity.' });
    }

    return {
        status: issues.some((issue) => issue.severity === 'critical') ? 'critical' : (issues.length ? 'warning' : 'healthy'),
        issues,
        recommendedActions: [
            issues.some((issue) => issue.code === 'wireguard_runtime_error' || issue.code === 'interface_down') ? 'restart_vpn' : null,
            issues.some((issue) => issue.code === 'stale_peers') ? 'reconcile' : null
        ].filter(Boolean)
    };
}

async function getAdminVpnServerActivity(serverId, filters = {}) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;

    let items = buildVpnServerActivity(bundle);
    const from = toDateOrNull(filters.from);
    const to = toDateOrNull(filters.to);

    if (filters.type) items = items.filter((item) => item.type === filters.type);
    if (filters.actor) {
        const actor = String(filters.actor).toLowerCase();
        items = items.filter((item) => String(item.actor || '').toLowerCase().includes(actor));
    }
    if (from || to) {
        items = items.filter((item) => {
            const ts = new Date(item.timestamp).getTime();
            if (from && ts < from.getTime()) return false;
            if (to && ts > to.getTime()) return false;
            return true;
        });
    }

    return paginate(items, filters.page, filters.limit);
}

async function getAdminVpnServerDiagnostics(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    return buildVpnServerDiagnostics(bundle);
}

async function getAdminVpnServerNotes(serverId) {
    const server = await VpnServer.findById(serverId).select('adminNotes');
    if (!server) return null;
    return (server.adminNotes || []).map(normalizeServerNote).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getAdminVpnServerFlags(serverId) {
    const server = await VpnServer.findById(serverId).select('internalFlags');
    if (!server) return null;
    return (server.internalFlags || []).map(normalizeServerFlag).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function addVpnServer(payload) {
    await ensureLocalVpnServer();
    const server = await VpnServer.create({
        nodeId: payload.nodeId,
        name: payload.name,
        region: payload.region || '',
        hostname: payload.hostname || '',
        endpoint: payload.endpoint || '',
        publicKey: payload.publicKey || '',
        controlMode: payload.controlMode || 'manual',
        enabled: payload.enabled !== false,
        maintenanceMode: Boolean(payload.maintenanceMode),
        status: payload.enabled === false ? 'disabled' : (payload.maintenanceMode ? 'maintenance' : 'unknown'),
        maxPeers: Number(payload.maxPeers || 0),
        maxRouters: Number(payload.maxRouters || 0)
    });
    return server;
}

async function disableVpnServer(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    if (bundle.routers.length > 0) {
        const hasActiveAssignments = bundle.routers.some((router) => ['active', 'pending', 'offline'].includes(router.status));
        if (hasActiveAssignments) {
            const error = new Error('Cannot disable a VPN server while routers are still assigned to it');
            error.code = 'SERVER_HAS_ACTIVE_ASSIGNMENTS';
            throw error;
        }
    }

    bundle.server.enabled = false;
    bundle.server.status = 'disabled';
    await bundle.server.save();
    return bundle.server;
}

async function reactivateVpnServer(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    bundle.server.enabled = true;
    bundle.server.status = bundle.server.maintenanceMode ? 'maintenance' : 'unknown';
    await bundle.server.save();
    return bundle.server;
}

async function setVpnServerMaintenance(serverId, enabled) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    bundle.server.maintenanceMode = enabled;
    bundle.server.status = enabled ? 'maintenance' : (bundle.server.enabled ? 'unknown' : 'disabled');
    await bundle.server.save();
    return bundle.server;
}

async function restartVpnServer(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    if (bundle.server.nodeId !== LOCAL_NODE_ID || bundle.server.controlMode !== 'local') {
        const error = new Error('VPN restart is only supported for the local WireGuard node in the current architecture');
        error.code = 'UNSUPPORTED_CONTROL_MODE';
        throw error;
    }

    await restartLocalWireGuard();
    bundle.server.lastRestartAt = new Date();
    bundle.server.status = 'healthy';
    await bundle.server.save();
    return bundle.server;
}

async function reconcileVpnServer(serverId) {
    const bundle = await getServerBundle(serverId);
    if (!bundle) return null;
    if (bundle.server.nodeId !== LOCAL_NODE_ID || bundle.server.controlMode !== 'local') {
        const error = new Error('Peer reconciliation is only supported for the local WireGuard node in the current architecture');
        error.code = 'UNSUPPORTED_CONTROL_MODE';
        throw error;
    }

    await reconcileLocalWireGuard();
    bundle.server.lastReconcileAt = new Date();
    await bundle.server.save();
    return bundle.server;
}

async function markVpnServerReviewed(serverId, reviewerEmail) {
    const server = await VpnServer.findById(serverId);
    if (!server) return null;
    server.reviewedAt = new Date();
    server.reviewedBy = reviewerEmail;
    await server.save();
    return server;
}

async function migrateRoutersBetweenServers(sourceServerId, targetServerId, routerIds = []) {
    const source = await getServerBundle(sourceServerId);
    const target = await getServerBundle(targetServerId);
    if (!source || !target) {
        const error = new Error('Source or target VPN server not found');
        error.code = 'SERVER_NOT_FOUND';
        throw error;
    }

    if (source.server.nodeId === target.server.nodeId) {
        return {
            sourceServer: source.server.nodeId,
            targetServer: target.server.nodeId,
            routersRequested: routerIds,
            routersMigrated: [],
            routersFailed: routerIds.map((id) => ({ routerId: id, reason: 'Source and target VPN servers are the same' }))
        };
    }

    const result = {
        sourceServer: source.server.nodeId,
        targetServer: target.server.nodeId,
        routersRequested: routerIds,
        routersMigrated: [],
        routersFailed: []
    };

    const allRequested = routerIds.length ? source.routers.filter((router) => routerIds.includes(String(router._id))) : source.routers;
    for (const router of allRequested) {
        result.routersFailed.push({
            routerId: String(router._id),
            reason: 'Router migration is not supported yet because the current system only has one real WireGuard control plane and no cross-node peer provisioning orchestration'
        });
    }

    return result;
}

module.exports = {
    ADMIN_VPN_SERVER_PERMISSIONS,
    VPN_SERVER_NOTE_CATEGORIES,
    VPN_SERVER_FLAG_TYPES,
    VPN_SERVER_FLAG_SEVERITIES,
    listAdminVpnServers,
    getAdminVpnServerStats,
    getAdminVpnServerDetail,
    getAdminVpnServerHealth,
    getAdminVpnServerRouters,
    getAdminVpnServerPeers,
    getAdminVpnServerTraffic,
    getAdminVpnServerActivity,
    getAdminVpnServerDiagnostics,
    getAdminVpnServerNotes,
    getAdminVpnServerFlags,
    addVpnServer,
    disableVpnServer,
    reactivateVpnServer,
    setVpnServerMaintenance,
    restartVpnServer,
    reconcileVpnServer,
    markVpnServerReviewed,
    migrateRoutersBetweenServers
};
