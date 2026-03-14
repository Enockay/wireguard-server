const MikrotikRouter = require('../models/MikrotikRouter');
const Client = require('../models/Client');
const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const Subscription = require('../models/Subscription');
const AdminAuditLog = require('../models/AdminAuditLog');
const MonitoringIncident = require('../models/MonitoringIncident');
const { listAdminRouters } = require('./admin-router-service');
const { listAdminVpnServers } = require('./admin-vpn-server-service');
const { getProxyStatus } = require('./tcp-proxy-service');
const { ensureLocalVpnServer } = require('./vpn-infrastructure-service');

const ADMIN_MONITORING_PERMISSIONS = {
    VIEW: 'admin.monitoring.view',
    VIEW_OVERVIEW: 'admin.monitoring.view_overview',
    VIEW_ROUTER_HEALTH: 'admin.monitoring.view_router_health',
    VIEW_SERVER_HEALTH: 'admin.monitoring.view_server_health',
    VIEW_PEER_HEALTH: 'admin.monitoring.view_peer_health',
    VIEW_TRAFFIC: 'admin.monitoring.view_traffic',
    VIEW_CUSTOMER_IMPACT: 'admin.monitoring.view_customer_impact',
    VIEW_DIAGNOSTICS: 'admin.monitoring.view_diagnostics',
    VIEW_INCIDENTS: 'admin.monitoring.view_incidents',
    MANAGE_INCIDENTS: 'admin.monitoring.manage_incidents',
    EXPORT: 'admin.monitoring.export'
};

const INCIDENT_NOTE_CATEGORIES = ['incident', 'follow_up', 'review', 'resolution'];
const TRAFFIC_TRENDS_UNSUPPORTED_REASON = 'Historical traffic snapshots are not stored in the current architecture, so only current aggregate transfer counters are available.';

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
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

function getWindowConfig(window = '24h') {
    const value = String(window || '24h').toLowerCase();
    if (value === '1h') return { key: '1h', ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };
    if (value === '7d') return { key: '7d', ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 };
    if (value === '30d') return { key: '30d', ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    return { key: '24h', ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 };
}

function createBuckets(windowConfig) {
    const now = Date.now();
    const start = now - windowConfig.ms;
    const buckets = [];
    for (let ts = start; ts <= now; ts += windowConfig.bucketMs) {
        buckets.push({
            timestamp: new Date(ts).toISOString(),
            incidentsOpened: 0,
            incidentsResolved: 0,
            routersCreated: 0,
            routersConnected: 0
        });
    }
    return buckets;
}

function addDateToBuckets(buckets, date, key, bucketMs) {
    if (!date) return;
    const time = new Date(date).getTime();
    if (Number.isNaN(time)) return;
    const first = new Date(buckets[0].timestamp).getTime();
    const last = new Date(buckets[buckets.length - 1].timestamp).getTime() + bucketMs;
    if (time < first || time > last) return;
    const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((time - first) / bucketMs)));
    buckets[index][key] += 1;
}

function getHandshakeAgeMs(lastHandshake) {
    if (!lastHandshake) return null;
    const time = new Date(lastHandshake).getTime();
    if (Number.isNaN(time)) return null;
    return Date.now() - time;
}

function getHandshakeState(client) {
    const age = getHandshakeAgeMs(client?.lastHandshake);
    if (age === null) return 'none';
    return age > 180000 ? 'stale' : 'fresh';
}

function getProvisioningState(router, client) {
    if (!client) return 'failed';
    if (router.status === 'inactive') return 'disabled';
    if (router.firstConnectedAt) return 'connected';
    if (router.provisioningError) return 'failed';
    if (router.lastSetupGeneratedAt || client.createdAt) return 'awaiting_connection';
    return 'pending';
}

function getRouterTelemetryState(router) {
    const lastChecked = router.routerboardInfo?.lastChecked ? new Date(router.routerboardInfo.lastChecked).getTime() : null;
    if (!lastChecked || Number.isNaN(lastChecked)) {
        return { lastTelemetryAt: null, staleTelemetry: true };
    }
    return {
        lastTelemetryAt: new Date(lastChecked),
        staleTelemetry: (Date.now() - lastChecked) > 10 * 60 * 1000
    };
}

function getProxyHealth(router) {
    const proxyStatus = getProxyStatus(router._id);
    const running = Boolean(proxyStatus.running);
    const unhealthyPorts = [];
    if (!router.ports?.winbox || !router.ports?.ssh || !router.ports?.api) {
        unhealthyPorts.push('missing_ports');
    }
    if (running) {
        if (!proxyStatus.winbox?.listening) unhealthyPorts.push('winbox_proxy_down');
        if (!proxyStatus.ssh?.listening) unhealthyPorts.push('ssh_proxy_down');
        if (!proxyStatus.api?.listening) unhealthyPorts.push('api_proxy_down');
    } else if (router.status !== 'inactive') {
        unhealthyPorts.push('proxy_stopped');
    }
    return {
        running,
        unhealthyPorts,
        proxyStatus
    };
}

function buildRouterOperationalState(router) {
    const client = router.wireguardClientId || null;
    const telemetry = getRouterTelemetryState(router);
    const proxy = getProxyHealth(router);
    const handshakeState = getHandshakeState(client);
    const issues = [];

    if (router.status === 'offline') issues.push('offline');
    if (!client) issues.push('missing_peer');
    if (client && !client.enabled) issues.push('peer_disabled');
    if (handshakeState === 'none') issues.push('no_handshake');
    if (handshakeState === 'stale') issues.push('stale_handshake');
    if (router.provisioningError) issues.push('provisioning_error');
    if (telemetry.staleTelemetry) issues.push('stale_telemetry');
    issues.push(...proxy.unhealthyPorts);

    return {
        router,
        client,
        telemetry,
        proxy,
        handshakeState,
        setupState: getProvisioningState(router, client),
        unhealthy: issues.length > 0,
        issues
    };
}

function normalizeIncidentNote(note) {
    return {
        id: String(note._id),
        body: note.body,
        author: note.author || 'system',
        category: note.category || 'incident',
        createdAt: note.createdAt
    };
}

function normalizeIncident(incident) {
    return {
        id: String(incident._id),
        incidentKey: incident.incidentKey,
        source: incident.source,
        sourceType: incident.sourceType,
        type: incident.type,
        severity: incident.severity,
        status: incident.status,
        title: incident.title,
        summary: incident.summary || '',
        impact: incident.impact || { affectedRouters: 0, affectedUsers: 0 },
        relatedUser: incident.relatedUserId ? {
            id: String(incident.relatedUserId._id || incident.relatedUserId),
            name: incident.relatedUserId.name || null,
            email: incident.relatedUserId.email || null
        } : null,
        relatedRouter: incident.relatedRouterId ? {
            id: String(incident.relatedRouterId._id || incident.relatedRouterId),
            name: incident.relatedRouterId.name || null,
            status: incident.relatedRouterId.status || null
        } : null,
        relatedServer: incident.relatedServerId ? {
            id: String(incident.relatedServerId._id || incident.relatedServerId),
            name: incident.relatedServerId.name || null,
            nodeId: incident.relatedServerId.nodeId || null
        } : null,
        relatedPeer: incident.relatedClientId ? {
            id: String(incident.relatedClientId._id || incident.relatedClientId),
            name: incident.relatedClientId.name || null,
            enabled: typeof incident.relatedClientId.enabled === 'boolean' ? incident.relatedClientId.enabled : null
        } : null,
        metadata: incident.metadata || {},
        firstDetectedAt: incident.firstDetectedAt,
        lastSeenAt: incident.lastSeenAt,
        acknowledgedAt: incident.acknowledgedAt || null,
        acknowledgedBy: incident.acknowledgedBy || null,
        resolvedAt: incident.resolvedAt || null,
        resolvedBy: incident.resolvedBy || null,
        reviewedAt: incident.reviewedAt || null,
        reviewedBy: incident.reviewedBy || null,
        notes: Array.isArray(incident.notes) ? incident.notes.map(normalizeIncidentNote) : []
    };
}

async function loadMonitoringDataset() {
    await ensureLocalVpnServer();
    const [routers, users, tickets, subscriptions, serversResult] = await Promise.all([
        MikrotikRouter.find({})
            .populate('userId', 'name email isActive emailVerified')
            .populate('wireguardClientId')
            .sort({ createdAt: -1 })
            .lean(),
        User.find({}, 'name email isActive emailVerified').lean(),
        SupportTicket.find({}).lean(),
        Subscription.find({}).lean(),
        listAdminVpnServers({ page: 1, limit: 1000 })
    ]);

    const routerStates = routers.map(buildRouterOperationalState);
    const openTickets = tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status));
    const subscriptionByRouterId = new Map(subscriptions.map((item) => [String(item.routerId), item]));
    const serverItems = serversResult.items || [];
    const serverByNodeId = new Map(serverItems.map((item) => [item.nodeId, item]));

    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const currentIssueUserIds = new Set();

    for (const state of routerStates) {
        if (state.unhealthy && state.router.userId) {
            currentIssueUserIds.add(String(state.router.userId._id || state.router.userId));
        }
        const server = serverByNodeId.get(state.router.serverNode || 'wireguard');
        if (server && server.healthSummary?.status !== 'healthy' && state.router.userId) {
            currentIssueUserIds.add(String(state.router.userId._id || state.router.userId));
        }
    }

    return {
        routers,
        routerStates,
        users,
        usersById,
        tickets,
        openTickets,
        subscriptions,
        subscriptionByRouterId,
        servers: serverItems,
        serverByNodeId,
        affectedUserIds: currentIssueUserIds
    };
}

function buildDerivedIncidents(dataset) {
    const incidents = [];
    const usersByServer = new Map();

    for (const state of dataset.routerStates) {
        const router = state.router;
        const userId = router.userId?._id || router.userId || null;
        const userKey = userId ? String(userId) : null;
        const baseMetadata = {
            routerStatus: router.status,
            setupState: state.setupState,
            handshakeState: state.handshakeState,
            lastSeen: router.lastSeen || null,
            lastTelemetryAt: state.telemetry.lastTelemetryAt || null,
            serverNode: router.serverNode || 'wireguard'
        };

        if (userKey) {
            if (!usersByServer.has(router.serverNode || 'wireguard')) {
                usersByServer.set(router.serverNode || 'wireguard', new Set());
            }
            usersByServer.get(router.serverNode || 'wireguard').add(userKey);
        }

        if (router.status === 'offline') {
            incidents.push({
                incidentKey: `router:${router._id}:offline`,
                sourceType: 'router',
                type: 'router_offline',
                severity: 'high',
                title: `Router ${router.name} is offline`,
                summary: 'The router monitoring loop marked this router as offline.',
                relatedUserId: userId || null,
                relatedRouterId: router._id,
                relatedServerId: null,
                relatedClientId: state.client?._id || null,
                impact: { affectedRouters: 1, affectedUsers: userKey ? 1 : 0 },
                metadata: baseMetadata
            });
        }

        if (router.provisioningError) {
            incidents.push({
                incidentKey: `router:${router._id}:provisioning_failure`,
                sourceType: 'router',
                type: 'provisioning_failure',
                severity: 'critical',
                title: `Router ${router.name} has a provisioning failure`,
                summary: router.provisioningError,
                relatedUserId: userId || null,
                relatedRouterId: router._id,
                relatedServerId: null,
                relatedClientId: state.client?._id || null,
                impact: { affectedRouters: 1, affectedUsers: userKey ? 1 : 0 },
                metadata: { ...baseMetadata, provisioningError: router.provisioningError }
            });
        }

        if (state.handshakeState === 'stale' || state.handshakeState === 'none') {
            incidents.push({
                incidentKey: `router:${router._id}:handshake_${state.handshakeState}`,
                sourceType: 'peer',
                type: state.handshakeState === 'stale' ? 'stale_handshake' : 'missing_handshake',
                severity: state.handshakeState === 'stale' ? 'high' : 'medium',
                title: `Router ${router.name} has ${state.handshakeState === 'stale' ? 'a stale handshake' : 'no handshake'}`,
                summary: 'The linked WireGuard peer has no recent handshake.',
                relatedUserId: userId || null,
                relatedRouterId: router._id,
                relatedServerId: null,
                relatedClientId: state.client?._id || null,
                impact: { affectedRouters: 1, affectedUsers: userKey ? 1 : 0 },
                metadata: baseMetadata
            });
        }

        if (state.telemetry.staleTelemetry) {
            incidents.push({
                incidentKey: `router:${router._id}:stale_telemetry`,
                sourceType: 'router',
                type: 'stale_telemetry',
                severity: 'medium',
                title: `Router ${router.name} has stale telemetry`,
                summary: 'Routerboard telemetry has not been refreshed recently.',
                relatedUserId: userId || null,
                relatedRouterId: router._id,
                relatedServerId: null,
                relatedClientId: state.client?._id || null,
                impact: { affectedRouters: 1, affectedUsers: userKey ? 1 : 0 },
                metadata: baseMetadata
            });
        }

        if (state.proxy.unhealthyPorts.length > 0) {
            incidents.push({
                incidentKey: `router:${router._id}:ports`,
                sourceType: 'router',
                type: 'port_mapping_issue',
                severity: 'high',
                title: `Router ${router.name} has a port access issue`,
                summary: 'Public access mappings are incomplete or proxy listeners are unhealthy.',
                relatedUserId: userId || null,
                relatedRouterId: router._id,
                relatedServerId: null,
                relatedClientId: state.client?._id || null,
                impact: { affectedRouters: 1, affectedUsers: userKey ? 1 : 0 },
                metadata: { ...baseMetadata, portIssues: state.proxy.unhealthyPorts }
            });
        }
    }

    for (const server of dataset.servers) {
        const affectedUsers = usersByServer.get(server.nodeId)?.size || 0;
        const affectedRouters = server.routerCount || 0;

        if (server.healthSummary?.status === 'degraded' || server.status === 'degraded') {
            incidents.push({
                incidentKey: `server:${server.id}:unhealthy`,
                sourceType: 'vpn_server',
                type: 'server_unhealthy',
                severity: 'critical',
                title: `VPN server ${server.name} is unhealthy`,
                summary: 'The server health summary reports a degraded state.',
                relatedUserId: null,
                relatedRouterId: null,
                relatedServerId: server.id,
                relatedClientId: null,
                impact: { affectedRouters, affectedUsers },
                metadata: {
                    nodeId: server.nodeId,
                    issues: server.healthSummary?.issues || [],
                    staleTelemetry: Boolean(server.healthSummary?.staleTelemetry)
                }
            });
        }

        if (server.loadCapacitySummary?.overloaded) {
            incidents.push({
                incidentKey: `server:${server.id}:overloaded`,
                sourceType: 'vpn_server',
                type: 'capacity_issue',
                severity: 'high',
                title: `VPN server ${server.name} is overloaded`,
                summary: 'Server capacity utilization is above the overload threshold.',
                relatedUserId: null,
                relatedRouterId: null,
                relatedServerId: server.id,
                relatedClientId: null,
                impact: { affectedRouters, affectedUsers },
                metadata: {
                    nodeId: server.nodeId,
                    loadCapacitySummary: server.loadCapacitySummary
                }
            });
        }

        if (server.healthSummary?.staleTelemetry) {
            incidents.push({
                incidentKey: `server:${server.id}:stale_telemetry`,
                sourceType: 'vpn_server',
                type: 'server_stale_telemetry',
                severity: 'medium',
                title: `VPN server ${server.name} has stale telemetry`,
                summary: 'The server has stale runtime or heartbeat data.',
                relatedUserId: null,
                relatedRouterId: null,
                relatedServerId: server.id,
                relatedClientId: null,
                impact: { affectedRouters, affectedUsers },
                metadata: {
                    nodeId: server.nodeId,
                    lastHeartbeatAt: server.lastHeartbeatAt || null,
                    lastHealthCheckAt: server.healthSummary?.lastHealthCheckAt || null
                }
            });
        }
    }

    return incidents;
}

async function synchronizeMonitoringIncidents() {
    const dataset = await loadMonitoringDataset();
    const derived = buildDerivedIncidents(dataset);
    const now = new Date();
    const existing = await MonitoringIncident.find({ source: 'derived' });
    const existingByKey = new Map(existing.map((item) => [item.incidentKey, item]));
    const activeKeys = new Set();

    for (const entry of derived) {
        activeKeys.add(entry.incidentKey);
        const existingIncident = existingByKey.get(entry.incidentKey);
        if (!existingIncident) {
            await MonitoringIncident.create({
                ...entry,
                source: 'derived',
                status: 'open',
                firstDetectedAt: now,
                lastSeenAt: now
            });
            continue;
        }

        existingIncident.type = entry.type;
        existingIncident.severity = entry.severity;
        existingIncident.title = entry.title;
        existingIncident.summary = entry.summary;
        existingIncident.sourceType = entry.sourceType;
        existingIncident.relatedUserId = entry.relatedUserId || null;
        existingIncident.relatedRouterId = entry.relatedRouterId || null;
        existingIncident.relatedServerId = entry.relatedServerId || null;
        existingIncident.relatedClientId = entry.relatedClientId || null;
        existingIncident.impact = entry.impact;
        existingIncident.metadata = entry.metadata;
        existingIncident.lastSeenAt = now;
        if (existingIncident.status === 'resolved') {
            existingIncident.status = 'open';
            existingIncident.resolvedAt = null;
            existingIncident.resolvedBy = '';
        }
        await existingIncident.save();
    }

    for (const existingIncident of existing) {
        if (!activeKeys.has(existingIncident.incidentKey) && existingIncident.status !== 'resolved') {
            existingIncident.status = 'resolved';
            existingIncident.resolvedAt = now;
            existingIncident.resolvedBy = 'system';
            existingIncident.metadata = {
                ...(existingIncident.metadata || {}),
                autoResolved: true
            };
            await existingIncident.save();
        }
    }

    return dataset;
}

async function getMonitoringOverview() {
    const dataset = await synchronizeMonitoringIncidents();
    const incidents = await MonitoringIncident.find({ status: { $in: ['open', 'acknowledged'] } }).lean();
    const totalPeers = dataset.routerStates.length;
    const activePeers = dataset.routerStates.filter((state) => state.handshakeState === 'fresh').length;
    const stalePeers = dataset.routerStates.filter((state) => state.handshakeState !== 'fresh').length;
    const missingPorts = dataset.routerStates.filter((state) => state.proxy.unhealthyPorts.includes('missing_ports')).length;
    const brokenAccessMappings = dataset.routerStates.filter((state) => state.proxy.unhealthyPorts.some((issue) => issue.endsWith('_proxy_down') || issue === 'proxy_stopped')).length;
    const unhealthyRouters = dataset.routerStates.filter((state) => state.unhealthy).length;
    const pendingSetupRouters = dataset.routerStates.filter((state) => ['pending', 'awaiting_connection'].includes(state.setupState)).length;
    const failedProvisioningRouters = dataset.routerStates.filter((state) => state.setupState === 'failed').length;
    const staleTelemetryRouters = dataset.routerStates.filter((state) => state.telemetry.staleTelemetry).length;

    return {
        routers: {
            total: dataset.routerStates.length,
            online: dataset.routerStates.filter((state) => state.router.status === 'active').length,
            offline: dataset.routerStates.filter((state) => state.router.status === 'offline').length,
            unhealthy: unhealthyRouters,
            pendingSetup: pendingSetupRouters,
            failedProvisioning: failedProvisioningRouters,
            staleTelemetry: staleTelemetryRouters,
            missingPorts,
            brokenAccessMappings
        },
        vpnServers: {
            total: dataset.servers.length,
            healthy: dataset.servers.filter((server) => server.healthSummary?.status === 'healthy').length,
            unhealthy: dataset.servers.filter((server) => server.healthSummary?.status === 'degraded').length,
            overloaded: dataset.servers.filter((server) => server.loadCapacitySummary?.overloaded).length,
            maintenance: dataset.servers.filter((server) => server.maintenanceMode).length,
            staleTelemetry: dataset.servers.filter((server) => server.healthSummary?.staleTelemetry).length
        },
        peers: {
            total: totalPeers,
            active: activePeers,
            stale: stalePeers
        },
        impact: {
            affectedUsers: dataset.affectedUserIds.size,
            openIncidents: incidents.filter((incident) => incident.status === 'open').length,
            acknowledgedIncidents: incidents.filter((incident) => incident.status === 'acknowledged').length
        },
        lastMonitoringSyncAt: new Date().toISOString()
    };
}

async function getMonitoringTrends(query = {}) {
    await synchronizeMonitoringIncidents();
    const windowConfig = getWindowConfig(query.window);
    const buckets = createBuckets(windowConfig);
    const start = new Date(Date.now() - windowConfig.ms);

    const [incidents, routers] = await Promise.all([
        MonitoringIncident.find({
            $or: [
                { firstDetectedAt: { $gte: start } },
                { resolvedAt: { $gte: start } }
            ]
        }).lean(),
        MikrotikRouter.find({
            $or: [
                { createdAt: { $gte: start } },
                { firstConnectedAt: { $gte: start } }
            ]
        }, 'createdAt firstConnectedAt').lean()
    ]);

    for (const incident of incidents) {
        addDateToBuckets(buckets, incident.firstDetectedAt, 'incidentsOpened', windowConfig.bucketMs);
        addDateToBuckets(buckets, incident.resolvedAt, 'incidentsResolved', windowConfig.bucketMs);
    }

    for (const router of routers) {
        addDateToBuckets(buckets, router.createdAt, 'routersCreated', windowConfig.bucketMs);
        addDateToBuckets(buckets, router.firstConnectedAt, 'routersConnected', windowConfig.bucketMs);
    }

    return {
        window: windowConfig.key,
        supportedSeries: ['incidentsOpened', 'incidentsResolved', 'routersCreated', 'routersConnected'],
        series: buckets
    };
}

async function getMonitoringDiagnostics() {
    const dataset = await synchronizeMonitoringIncidents();
    const issues = [];

    for (const state of dataset.routerStates) {
        const router = state.router;
        if (!state.client) {
            issues.push({
                code: 'router_missing_peer',
                severity: 'critical',
                resourceType: 'router',
                resourceId: String(router._id),
                resourceName: router.name,
                message: 'Router is missing its linked WireGuard peer.'
            });
        }
        if (!router.serverNode || !dataset.serverByNodeId.has(router.serverNode)) {
            issues.push({
                code: 'router_missing_server_assignment',
                severity: 'high',
                resourceType: 'router',
                resourceId: String(router._id),
                resourceName: router.name,
                message: 'Router does not have a valid VPN server assignment.'
            });
        }
        if (state.proxy.unhealthyPorts.length > 0) {
            issues.push({
                code: 'router_port_mapping_issue',
                severity: 'high',
                resourceType: 'router',
                resourceId: String(router._id),
                resourceName: router.name,
                message: `Router has unhealthy public access mappings: ${state.proxy.unhealthyPorts.join(', ')}.`
            });
        }
        if (state.handshakeState !== 'fresh') {
            issues.push({
                code: 'router_handshake_issue',
                severity: state.handshakeState === 'stale' ? 'high' : 'medium',
                resourceType: 'router',
                resourceId: String(router._id),
                resourceName: router.name,
                message: `Router peer handshake state is ${state.handshakeState}.`
            });
        }
    }

    for (const server of dataset.servers) {
        if (server.healthSummary?.status !== 'healthy') {
            issues.push({
                code: 'vpn_server_unhealthy',
                severity: 'critical',
                resourceType: 'vpn_server',
                resourceId: String(server.id),
                resourceName: server.name,
                message: `VPN server health is ${server.healthSummary?.status || server.status}.`
            });
        }
        if (server.loadCapacitySummary?.overloaded) {
            issues.push({
                code: 'vpn_server_overloaded',
                severity: 'high',
                resourceType: 'vpn_server',
                resourceId: String(server.id),
                resourceName: server.name,
                message: 'VPN server is at or above the overload threshold.'
            });
        }
    }

    const incidents = await MonitoringIncident.find({ status: { $in: ['open', 'acknowledged'] } }).lean();
    return {
        status: issues.some((issue) => issue.severity === 'critical') ? 'critical' : (issues.length ? 'warning' : 'healthy'),
        summary: {
            totalIssues: issues.length,
            criticalIssues: issues.filter((issue) => issue.severity === 'critical').length,
            highIssues: issues.filter((issue) => issue.severity === 'high').length,
            openIncidents: incidents.length
        },
        issues
    };
}

async function getMonitoringActivity(query = {}) {
    await synchronizeMonitoringIncidents();
    const [routers, audits, incidents, tickets] = await Promise.all([
        MikrotikRouter.find({
            $or: [
                { createdAt: { $exists: true } },
                { firstConnectedAt: { $exists: true } },
                { lastSeen: { $exists: true } }
            ]
        }, 'name status createdAt firstConnectedAt lastSeen').sort({ updatedAt: -1 }).limit(100).lean(),
        AdminAuditLog.find({})
            .populate('actorUserId', 'name email')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean(),
        MonitoringIncident.find({})
            .populate('relatedRouterId', 'name')
            .populate('relatedServerId', 'name nodeId')
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean(),
        SupportTicket.find({}, 'subject status priority category userId createdAt updatedAt').sort({ updatedAt: -1 }).limit(100).lean()
    ]);

    const items = [];
    const typeFilter = query.type ? String(query.type) : '';
    const sourceFilter = query.source ? String(query.source) : '';
    const severityFilter = query.severity ? String(query.severity) : '';
    const from = toDateOrNull(query.from);
    const to = toDateOrNull(query.to);

    for (const router of routers) {
        items.push({
            id: `router-created-${router._id}`,
            type: 'router_created',
            source: 'router',
            severity: 'info',
            summary: `Router ${router.name} was created`,
            timestamp: router.createdAt,
            resource: { type: 'router', id: String(router._id), name: router.name }
        });
        if (router.firstConnectedAt) {
            items.push({
                id: `router-connected-${router._id}`,
                type: 'router_connected',
                source: 'router',
                severity: 'info',
                summary: `Router ${router.name} completed its first connection`,
                timestamp: router.firstConnectedAt,
                resource: { type: 'router', id: String(router._id), name: router.name }
            });
        }
        if (router.status === 'offline' && router.lastSeen) {
            items.push({
                id: `router-offline-${router._id}`,
                type: 'router_offline',
                source: 'router',
                severity: 'high',
                summary: `Router ${router.name} was last seen before going offline`,
                timestamp: router.lastSeen,
                resource: { type: 'router', id: String(router._id), name: router.name }
            });
        }
    }

    for (const audit of audits) {
        items.push({
            id: `audit-${audit._id}`,
            type: audit.action,
            source: 'admin',
            severity: 'info',
            summary: audit.reason || audit.action,
            timestamp: audit.createdAt,
            actor: audit.actorUserId ? {
                id: String(audit.actorUserId._id),
                name: audit.actorUserId.name,
                email: audit.actorUserId.email
            } : null,
            metadata: audit.metadata || {}
        });
    }

    for (const incident of incidents) {
        items.push({
            id: `incident-${incident._id}`,
            type: `incident_${incident.status}`,
            source: 'incident',
            severity: incident.severity,
            summary: incident.title,
            timestamp: incident.updatedAt || incident.lastSeenAt,
            resource: incident.relatedRouterId ? {
                type: 'router',
                id: String(incident.relatedRouterId._id),
                name: incident.relatedRouterId.name
            } : (incident.relatedServerId ? {
                type: 'vpn_server',
                id: String(incident.relatedServerId._id),
                name: incident.relatedServerId.name
            } : null)
        });
    }

    for (const ticket of tickets) {
        items.push({
            id: `support-${ticket._id}`,
            type: 'support_ticket_updated',
            source: 'support',
            severity: ticket.priority === 'urgent' ? 'high' : 'info',
            summary: `Support ticket "${ticket.subject}" is ${ticket.status}`,
            timestamp: ticket.updatedAt || ticket.createdAt,
            metadata: {
                priority: ticket.priority,
                category: ticket.category
            }
        });
    }

    let filtered = items.filter((item) => {
        const timestamp = item.timestamp ? new Date(item.timestamp).getTime() : 0;
        if (typeFilter && item.type !== typeFilter) return false;
        if (sourceFilter && item.source !== sourceFilter) return false;
        if (severityFilter && item.severity !== severityFilter) return false;
        if (from && timestamp < from.getTime()) return false;
        if (to && timestamp > to.getTime()) return false;
        return true;
    });

    filtered = filtered.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(filtered, query.page, query.limit);
}

async function getRouterHealthSummary() {
    const dataset = await loadMonitoringDataset();
    const byStatus = {
        pending: 0,
        active: 0,
        inactive: 0,
        offline: 0
    };
    const bySetupState = {
        pending: 0,
        awaiting_connection: 0,
        connected: 0,
        failed: 0,
        disabled: 0
    };
    const byServer = {};

    for (const state of dataset.routerStates) {
        byStatus[state.router.status] = (byStatus[state.router.status] || 0) + 1;
        bySetupState[state.setupState] = (bySetupState[state.setupState] || 0) + 1;
        const serverNode = state.router.serverNode || 'wireguard';
        byServer[serverNode] = (byServer[serverNode] || 0) + 1;
    }

    return {
        totalRouters: dataset.routerStates.length,
        byStatus,
        bySetupState,
        staleHandshakeRouters: dataset.routerStates.filter((state) => state.handshakeState === 'stale').length,
        noHandshakeRouters: dataset.routerStates.filter((state) => state.handshakeState === 'none').length,
        staleTelemetryRouters: dataset.routerStates.filter((state) => state.telemetry.staleTelemetry).length,
        missingPortsRouters: dataset.routerStates.filter((state) => state.proxy.unhealthyPorts.includes('missing_ports')).length,
        unhealthyRouters: dataset.routerStates.filter((state) => state.unhealthy).length,
        byServer
    };
}

async function listUnhealthyRouters(query = {}) {
    return listAdminRouters({ ...query, unhealthyState: 'true' });
}

async function listOfflineRouters(query = {}) {
    return listAdminRouters({ ...query, connectionStatus: 'offline' });
}

async function listProvisioningIssueRouters(query = {}) {
    return listAdminRouters({ ...query, setupStatus: 'failed' });
}

async function listStaleRouters(query = {}) {
    return listAdminRouters({ ...query, handshakeState: 'stale' });
}

async function getVpnServerHealthSummary() {
    const directory = await listAdminVpnServers({ page: 1, limit: 1000 });
    const items = directory.items || [];
    return {
        totalServers: items.length,
        healthyServers: items.filter((item) => item.healthSummary?.status === 'healthy').length,
        unhealthyServers: items.filter((item) => item.healthSummary?.status === 'degraded').length,
        maintenanceServers: items.filter((item) => item.maintenanceMode).length,
        overloadedServers: items.filter((item) => item.loadCapacitySummary?.overloaded).length,
        staleServers: items.filter((item) => item.healthSummary?.staleTelemetry).length,
        totalPeers: items.reduce((sum, item) => sum + (item.activePeerCount || 0), 0),
        totalRouters: items.reduce((sum, item) => sum + (item.routerCount || 0), 0),
        topImpactServers: items
            .map((item) => ({
                id: item.id,
                nodeId: item.nodeId,
                name: item.name,
                affectedRouters: item.routerCount || 0,
                healthStatus: item.healthSummary?.status || item.status
            }))
            .sort((a, b) => b.affectedRouters - a.affectedRouters)
            .slice(0, 5)
    };
}

async function listUnhealthyVpnServers(query = {}) {
    return listAdminVpnServers({ ...query, healthStatus: 'degraded' });
}

async function listOverloadedVpnServers(query = {}) {
    return listAdminVpnServers({ ...query, overloaded: 'true' });
}

async function listStaleVpnServers(query = {}) {
    const result = await listAdminVpnServers({ ...query, page: 1, limit: 1000 });
    const filtered = (result.items || []).filter((item) => item.healthSummary?.staleTelemetry);
    return paginate(filtered, query.page, query.limit);
}

async function getPeerHealthSummary() {
    const dataset = await loadMonitoringDataset();
    const peers = dataset.routerStates.map((state) => state.client).filter(Boolean);
    return {
        totalPeers: peers.length,
        activePeers: dataset.routerStates.filter((state) => state.handshakeState === 'fresh').length,
        stalePeers: dataset.routerStates.filter((state) => state.handshakeState === 'stale').length,
        peersWithNoHandshake: dataset.routerStates.filter((state) => state.handshakeState === 'none').length,
        disabledPeers: peers.filter((peer) => !peer.enabled).length,
        unlinkedRouters: dataset.routerStates.filter((state) => !state.client).length,
        totalTransferRx: peers.reduce((sum, peer) => sum + (peer.transferRx || 0), 0),
        totalTransferTx: peers.reduce((sum, peer) => sum + (peer.transferTx || 0), 0)
    };
}

async function listStalePeers(query = {}) {
    const dataset = await loadMonitoringDataset();
    const items = dataset.routerStates
        .filter((state) => state.handshakeState === 'stale' || state.handshakeState === 'none')
        .map((state) => ({
            id: state.client ? String(state.client._id) : `missing-${state.router._id}`,
            peerName: state.client?.name || null,
            router: {
                id: String(state.router._id),
                name: state.router.name
            },
            user: state.router.userId ? {
                id: String(state.router.userId._id || state.router.userId),
                name: state.router.userId.name || null,
                email: state.router.userId.email || null
            } : null,
            enabled: Boolean(state.client?.enabled),
            handshakeState: state.handshakeState,
            lastHandshake: state.client?.lastHandshake || null,
            transferRx: state.client?.transferRx || 0,
            transferTx: state.client?.transferTx || 0,
            serverNode: state.router.serverNode || 'wireguard'
        }))
        .sort((a, b) => new Date(b.lastHandshake || 0).getTime() - new Date(a.lastHandshake || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function listUnhealthyPeers(query = {}) {
    const dataset = await loadMonitoringDataset();
    const items = dataset.routerStates
        .filter((state) => !state.client || !state.client.enabled || state.handshakeState !== 'fresh')
        .map((state) => ({
            id: state.client ? String(state.client._id) : `missing-${state.router._id}`,
            peerName: state.client?.name || null,
            router: {
                id: String(state.router._id),
                name: state.router.name
            },
            enabled: Boolean(state.client?.enabled),
            handshakeState: state.handshakeState,
            issues: state.issues.filter((issue) => ['missing_peer', 'peer_disabled', 'no_handshake', 'stale_handshake'].includes(issue)),
            transferRx: state.client?.transferRx || 0,
            transferTx: state.client?.transferTx || 0
        }));
    return paginate(items, query.page, query.limit);
}

async function getTrafficSummary() {
    const dataset = await loadMonitoringDataset();
    const topRouters = dataset.routerStates
        .map((state) => ({
            id: String(state.router._id),
            name: state.router.name,
            user: state.router.userId ? {
                id: String(state.router.userId._id || state.router.userId),
                name: state.router.userId.name || null,
                email: state.router.userId.email || null
            } : null,
            serverNode: state.router.serverNode || 'wireguard',
            transferRx: state.client?.transferRx || 0,
            transferTx: state.client?.transferTx || 0,
            totalTransferBytes: (state.client?.transferRx || 0) + (state.client?.transferTx || 0)
        }))
        .sort((a, b) => b.totalTransferBytes - a.totalTransferBytes);

    const serverTotals = new Map();
    for (const item of topRouters) {
        if (!serverTotals.has(item.serverNode)) {
            serverTotals.set(item.serverNode, { nodeId: item.serverNode, transferRx: 0, transferTx: 0, totalTransferBytes: 0 });
        }
        const target = serverTotals.get(item.serverNode);
        target.transferRx += item.transferRx;
        target.transferTx += item.transferTx;
        target.totalTransferBytes += item.totalTransferBytes;
    }

    return {
        totalTransferRx: topRouters.reduce((sum, item) => sum + item.transferRx, 0),
        totalTransferTx: topRouters.reduce((sum, item) => sum + item.transferTx, 0),
        totalTransferBytes: topRouters.reduce((sum, item) => sum + item.totalTransferBytes, 0),
        topRouters: topRouters.slice(0, 5),
        topServers: Array.from(serverTotals.values()).sort((a, b) => b.totalTransferBytes - a.totalTransferBytes).slice(0, 5)
    };
}

async function getTrafficTrends(query = {}) {
    const summary = await getTrafficSummary();
    return {
        window: getWindowConfig(query.window).key,
        supported: false,
        reason: TRAFFIC_TRENDS_UNSUPPORTED_REASON,
        series: [{
            timestamp: new Date().toISOString(),
            totalTransferRx: summary.totalTransferRx,
            totalTransferTx: summary.totalTransferTx,
            totalTransferBytes: summary.totalTransferBytes
        }]
    };
}

async function getTopTrafficRouters(query = {}) {
    const dataset = await loadMonitoringDataset();
    const items = dataset.routerStates
        .map((state) => ({
            id: String(state.router._id),
            name: state.router.name,
            user: state.router.userId ? {
                id: String(state.router.userId._id || state.router.userId),
                name: state.router.userId.name || null,
                email: state.router.userId.email || null
            } : null,
            serverNode: state.router.serverNode || 'wireguard',
            transferRx: state.client?.transferRx || 0,
            transferTx: state.client?.transferTx || 0,
            totalTransferBytes: (state.client?.transferRx || 0) + (state.client?.transferTx || 0)
        }))
        .sort((a, b) => b.totalTransferBytes - a.totalTransferBytes);
    return paginate(items, query.page, query.limit);
}

async function getTopTrafficServers(query = {}) {
    const routers = await getTopTrafficRouters({ page: 1, limit: 10000 });
    const totals = new Map();
    for (const item of routers.items) {
        if (!totals.has(item.serverNode)) {
            totals.set(item.serverNode, { nodeId: item.serverNode, transferRx: 0, transferTx: 0, totalTransferBytes: 0 });
        }
        const target = totals.get(item.serverNode);
        target.transferRx += item.transferRx;
        target.transferTx += item.transferTx;
        target.totalTransferBytes += item.totalTransferBytes;
    }
    const items = Array.from(totals.values()).sort((a, b) => b.totalTransferBytes - a.totalTransferBytes);
    return paginate(items, query.page, query.limit);
}

async function buildAffectedCustomerItems() {
    const dataset = await loadMonitoringDataset();
    const impactByUser = new Map();

    for (const state of dataset.routerStates) {
        const user = state.router.userId;
        if (!user) continue;
        const key = String(user._id || user);
        if (!impactByUser.has(key)) {
            impactByUser.set(key, {
                user: {
                    id: key,
                    name: user.name || null,
                    email: user.email || null,
                    isActive: typeof user.isActive === 'boolean' ? user.isActive : null
                },
                offlineRouters: 0,
                unhealthyRouters: 0,
                failedProvisioningRouters: 0,
                staleRouters: 0,
                affectedByServer: false
            });
        }
        const entry = impactByUser.get(key);
        if (state.router.status === 'offline') entry.offlineRouters += 1;
        if (state.unhealthy) entry.unhealthyRouters += 1;
        if (state.setupState === 'failed') entry.failedProvisioningRouters += 1;
        if (state.handshakeState !== 'fresh') entry.staleRouters += 1;
        const server = dataset.serverByNodeId.get(state.router.serverNode || 'wireguard');
        if (server && server.healthSummary?.status !== 'healthy') {
            entry.affectedByServer = true;
        }
    }

    return Array.from(impactByUser.values()).filter((entry) => (
        entry.offlineRouters > 0 ||
        entry.unhealthyRouters > 0 ||
        entry.failedProvisioningRouters > 0 ||
        entry.affectedByServer
    ));
}

async function getCustomerImpactSummary() {
    const items = await buildAffectedCustomerItems();

    return {
        affectedUsers: items.length,
        customersWithOfflineRouters: items.filter((entry) => entry.offlineRouters > 0).length,
        customersWithProvisioningFailures: items.filter((entry) => entry.failedProvisioningRouters > 0).length,
        customersAffectedByServerIssues: items.filter((entry) => entry.affectedByServer).length,
        topAffectedCustomers: items
            .sort((a, b) => (b.unhealthyRouters + b.offlineRouters) - (a.unhealthyRouters + a.offlineRouters))
            .slice(0, 5)
    };
}

async function listAffectedCustomers(query = {}) {
    const items = await buildAffectedCustomerItems();
    const sorted = items.sort((a, b) => (b.unhealthyRouters + b.offlineRouters) - (a.unhealthyRouters + a.offlineRouters));
    return paginate(sorted, query.page, query.limit);
}

async function getProvisioningSummary() {
    const dataset = await loadMonitoringDataset();
    const awaitingFirstHandshake = dataset.routerStates.filter((state) => state.setupState === 'awaiting_connection').length;
    const failed = dataset.routerStates.filter((state) => state.setupState === 'failed').length;
    const connected = dataset.routerStates.filter((state) => state.setupState === 'connected').length;
    const pending = dataset.routerStates.filter((state) => state.setupState === 'pending').length;

    let totalSetupCompletionMs = 0;
    let setupCompletionCount = 0;
    for (const state of dataset.routerStates) {
        if (state.router.createdAt && state.router.firstConnectedAt) {
            const createdAt = new Date(state.router.createdAt).getTime();
            const connectedAt = new Date(state.router.firstConnectedAt).getTime();
            if (!Number.isNaN(createdAt) && !Number.isNaN(connectedAt) && connectedAt >= createdAt) {
                totalSetupCompletionMs += (connectedAt - createdAt);
                setupCompletionCount += 1;
            }
        }
    }

    return {
        totalRouters: dataset.routerStates.length,
        pendingSetup: pending,
        awaitingFirstHandshake,
        setupSucceeded: connected,
        provisioningFailures: failed,
        averageSetupCompletionMinutes: setupCompletionCount ? Number((totalSetupCompletionMs / setupCompletionCount / 60000).toFixed(2)) : null
    };
}

async function getProvisioningTrends(query = {}) {
    const windowConfig = getWindowConfig(query.window);
    const buckets = createBuckets(windowConfig);
    const start = new Date(Date.now() - windowConfig.ms);
    const routers = await MikrotikRouter.find({
        $or: [
            { createdAt: { $gte: start } },
            { firstConnectedAt: { $gte: start } }
        ]
    }, 'createdAt firstConnectedAt provisioningError updatedAt').lean();

    for (const router of routers) {
        addDateToBuckets(buckets, router.createdAt, 'routersCreated', windowConfig.bucketMs);
        addDateToBuckets(buckets, router.firstConnectedAt, 'routersConnected', windowConfig.bucketMs);
        if (router.provisioningError) {
            addDateToBuckets(buckets, router.updatedAt || router.createdAt, 'incidentsOpened', windowConfig.bucketMs);
        }
    }

    return {
        window: windowConfig.key,
        series: buckets.map((bucket) => ({
            timestamp: bucket.timestamp,
            setupRequested: bucket.routersCreated,
            setupCompleted: bucket.routersConnected,
            provisioningFailures: bucket.incidentsOpened
        }))
    };
}

async function listProvisioningFailures(query = {}) {
    return listAdminRouters({ ...query, setupStatus: 'failed' });
}

async function listMonitoringIncidents(query = {}) {
    await synchronizeMonitoringIncidents();
    const filter = {};
    if (query.status) filter.status = query.status;
    else filter.status = { $in: ['open', 'acknowledged', 'resolved'] };
    if (query.type) filter.type = query.type;
    if (query.severity) filter.severity = query.severity;
    if (query.sourceType) filter.sourceType = query.sourceType;

    const q = String(query.q || '').trim();
    if (q) {
        const regex = new RegExp(escapeRegex(q), 'i');
        filter.$or = [{ title: regex }, { summary: regex }, { incidentKey: regex }];
    }

    const incidents = await MonitoringIncident.find(filter)
        .populate('relatedUserId', 'name email')
        .populate('relatedRouterId', 'name status')
        .populate('relatedServerId', 'name nodeId')
        .populate('relatedClientId', 'name enabled')
        .sort({ lastSeenAt: -1, createdAt: -1 })
        .lean();

    const from = toDateOrNull(query.from);
    const to = toDateOrNull(query.to);
    const items = incidents.filter((incident) => {
        const time = new Date(incident.lastSeenAt || incident.createdAt).getTime();
        if (from && time < from.getTime()) return false;
        if (to && time > to.getTime()) return false;
        return true;
    }).map(normalizeIncident);

    return paginate(items, query.page, query.limit);
}

async function getMonitoringIncidentDetail(incidentId) {
    await synchronizeMonitoringIncidents();
    const incident = await MonitoringIncident.findById(incidentId)
        .populate('relatedUserId', 'name email')
        .populate('relatedRouterId', 'name status')
        .populate('relatedServerId', 'name nodeId')
        .populate('relatedClientId', 'name enabled')
        .lean();
    if (!incident) return null;
    return normalizeIncident(incident);
}

async function getMonitoringIncidentDocument(incidentId) {
    return MonitoringIncident.findById(incidentId);
}

async function acknowledgeMonitoringIncident(incidentId, adminEmail) {
    const incident = await MonitoringIncident.findById(incidentId);
    if (!incident) return null;
    incident.status = 'acknowledged';
    incident.acknowledgedAt = new Date();
    incident.acknowledgedBy = adminEmail;
    await incident.save();
    return incident;
}

async function resolveMonitoringIncident(incidentId, adminEmail) {
    const incident = await MonitoringIncident.findById(incidentId);
    if (!incident) return null;
    incident.status = 'resolved';
    incident.resolvedAt = new Date();
    incident.resolvedBy = adminEmail;
    await incident.save();
    return incident;
}

async function markMonitoringIncidentReviewed(incidentId, adminEmail) {
    const incident = await MonitoringIncident.findById(incidentId);
    if (!incident) return null;
    incident.reviewedAt = new Date();
    incident.reviewedBy = adminEmail;
    await incident.save();
    return incident;
}

async function getMonitoringIncidentNotes(incidentId) {
    const incident = await MonitoringIncident.findById(incidentId).lean();
    if (!incident) return null;
    return (incident.notes || []).map(normalizeIncidentNote);
}

async function addMonitoringIncidentNote(incidentId, payload) {
    const incident = await MonitoringIncident.findById(incidentId);
    if (!incident) return null;
    incident.notes.push({
        body: String(payload.body).trim(),
        category: payload.category || 'incident',
        author: payload.author || 'system'
    });
    await incident.save();
    return incident;
}

module.exports = {
    ADMIN_MONITORING_PERMISSIONS,
    INCIDENT_NOTE_CATEGORIES,
    getMonitoringOverview,
    getMonitoringTrends,
    getMonitoringActivity,
    getMonitoringDiagnostics,
    getRouterHealthSummary,
    listUnhealthyRouters,
    listOfflineRouters,
    listProvisioningIssueRouters,
    listStaleRouters,
    getVpnServerHealthSummary,
    listUnhealthyVpnServers,
    listOverloadedVpnServers,
    listStaleVpnServers,
    getPeerHealthSummary,
    listStalePeers,
    listUnhealthyPeers,
    getTrafficSummary,
    getTrafficTrends,
    getTopTrafficRouters,
    getTopTrafficServers,
    getCustomerImpactSummary,
    listAffectedCustomers,
    getProvisioningSummary,
    getProvisioningTrends,
    listProvisioningFailures,
    listMonitoringIncidents,
    getMonitoringIncidentDetail,
    getMonitoringIncidentDocument,
    acknowledgeMonitoringIncident,
    resolveMonitoringIncident,
    markMonitoringIncidentReviewed,
    getMonitoringIncidentNotes,
    addMonitoringIncidentNote
};
