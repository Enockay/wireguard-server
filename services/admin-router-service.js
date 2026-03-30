const mongoose = require('mongoose');
const MikrotikRouter = require('../models/MikrotikRouter');
const User = require('../models/User');
const Client = require('../models/Client');
const Subscription = require('../models/Subscription');
const ServicePlan = require('../models/ServicePlan');
const Transaction = require('../models/Transaction');
const AdminAuditLog = require('../models/AdminAuditLog');
const RouterDiscoverySession = require('../models/RouterDiscoverySession');
const { allocatePorts, releasePorts } = require('../utils/port-allocator');
const { generateKeys, getNextAvailableIP } = require('../utils/route-helpers');
const { startRouterProxy, stopRouterProxy, restartRouterProxy, getProxyStatus } = require('./tcp-proxy-service');
const { wgLock, runWgCommand, KEEPALIVE_TIME, validateKeepalive, getServerEndpoint, getServerPublicKey, log } = require('../wg-core');
const { createSubscription } = require('./billing-service');
const { sendRouterDeletedEmail } = require('./email-service');
const { execute: executeRouterOperation } = require('./router-execution-service');
const { getLatestDownstreamDiscoveryRun } = require('./downstream-mikrotik-discovery-service');

const ROUTER_NOTE_CATEGORIES = ['support', 'provisioning', 'monitoring', 'billing', 'abuse', 'infrastructure', 'follow_up'];
const ROUTER_FLAG_TYPES = ['provisioning_issue', 'unstable', 'under_investigation', 'vip_customer_router', 'billing_hold', 'manual_review'];
const ROUTER_FLAG_SEVERITIES = ['low', 'medium', 'high'];
const CLIENT_IP_RETRY_LIMIT = 5;
const ROUTER_MONTHLY_PRICE = parseFloat(process.env.ROUTER_MONTHLY_PRICE || '10.00');
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
    EXPORT: 'admin.routers.export',
    CREATE: 'admin.routers.create',
    LIVE_OPS: 'admin.routers.live_ops',
    RUN_COMMAND: 'admin.routers.run_command'
};

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateClientIpError(error) {
    if (!error || error.code !== 11000) return false;
    if (error.keyPattern?.ip) return true;
    if (typeof error.message === 'string' && error.message.includes('ip')) return true;
    return error.keyValue?.ip != null;
}

function isInsufficientBalanceError(error) {
    return /insufficient balance/i.test(String(error?.message || ''));
}

async function createPastDueSubscription(userId, routerId, reason) {
    const existing = await Subscription.findOne({ routerId }).lean().catch(() => null);
    if (existing) return existing;

    const fallbackPlan = await ServicePlan.findOne({ isActive: true }).sort({ price: 1 }).lean().catch(() => null);
    const now = new Date();

    const subscription = new Subscription({
        userId,
        routerId,
        status: 'past_due',
        planType: 'monthly',
        pricePerMonth: ROUTER_MONTHLY_PRICE,
        currentPeriodStart: now,
        currentPeriodEnd: now,
        nextBillingDate: now,
        paymentMethod: 'manual',
        servicePlanId: fallbackPlan?._id || null
    });

    await subscription.save();
    log('warn', 'admin_router_subscription_marked_past_due', { userId, routerId, reason });
    return subscription;
}

async function createWireGuardClientRecord({
    name,
    notes,
    createdBy,
    dbInitialized = true,
    preferredIp
}) {
    const { privateKey, publicKey } = await generateKeys();
    let nextPreferredIp = preferredIp;

    for (let attempt = 0; attempt < CLIENT_IP_RETRY_LIMIT; attempt += 1) {
        const allocatedIp = nextPreferredIp || await getNextAvailableIP(dbInitialized);

        try {
            const client = new Client({
                name,
                ip: allocatedIp,
                publicKey,
                privateKey,
                enabled: true,
                notes,
                createdBy
            });

            await client.save();
            return client;
        } catch (error) {
            if (!isDuplicateClientIpError(error)) {
                throw error;
            }
            nextPreferredIp = null;
        }
    }

    throw new Error('Unable to allocate a unique VPN IP after multiple attempts');
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

function isManagementOnlyRouter(router) {
    return router?.connectionMode === 'management_only';
}

function resolveOwnerTunnelContext(router, ownerRouters = []) {
    const currentRouterId = String(router?._id || '');
    const candidates = (ownerRouters || [])
        .filter((candidate) => String(candidate?._id || '') !== currentRouterId)
        .filter((candidate) => candidate?.connectionMode !== 'management_only')
        .map((candidate) => ({
            router: candidate,
            client: candidate?.wireguardClientId || null
        }))
        .filter((candidate) => candidate.client);

    if (!candidates.length) return null;

    candidates.sort((left, right) => {
        const leftHandshake = getLastHandshakeDate(left.client)?.getTime() || 0;
        const rightHandshake = getLastHandshakeDate(right.client)?.getTime() || 0;
        if (leftHandshake !== rightHandshake) return rightHandshake - leftHandshake;
        const leftOnline = left.router?.status === 'active' ? 1 : 0;
        const rightOnline = right.router?.status === 'active' ? 1 : 0;
        if (leftOnline !== rightOnline) return rightOnline - leftOnline;
        return new Date(right.router?.createdAt || 0).getTime() - new Date(left.router?.createdAt || 0).getTime();
    });

    const selected = candidates[0];
    return {
        router: selected.router,
        client: selected.client
    };
}

function buildOwnerTunnelSummary(router, ownerTunnelContext) {
    if (!ownerTunnelContext?.client || !ownerTunnelContext?.router) return null;
    const ownerClient = ownerTunnelContext.client;
    const ownerRouter = ownerTunnelContext.router;
    return {
        source: 'owner_wireguard',
        sourceRouterId: String(ownerRouter._id),
        sourceRouterName: ownerRouter.name || null,
        peerId: String(ownerClient._id),
        peerName: ownerClient.name || null,
        peerEnabled: Boolean(ownerClient.enabled),
        serverNode: ownerRouter.serverNode || 'wireguard',
        vpnIp: ownerClient.ip || ownerRouter.vpnIp || null,
        publicKeyFingerprint: formatPublicKeyFingerprint(ownerClient.publicKey),
        lastHandshake: getLastHandshakeDate(ownerClient) || null,
        handshakeState: getHandshakeState(ownerClient),
        transferRx: ownerClient.transferRx || 0,
        transferTx: ownerClient.transferTx || 0,
        tunnelStatus: deriveConnectionStatus(ownerRouter, ownerClient),
        peerCreatedAt: ownerClient.createdAt || null
    };
}

function buildDirectTunnelSummary(router, client) {
    if (!client) return null;
    return {
        source: 'router_wireguard',
        sourceRouterId: String(router._id),
        sourceRouterName: router.name || null,
        peerId: String(client._id),
        peerName: client.name || null,
        peerEnabled: Boolean(client.enabled),
        serverNode: router.serverNode || 'wireguard',
        vpnIp: client.ip || router.vpnIp || null,
        publicKeyFingerprint: formatPublicKeyFingerprint(client.publicKey),
        lastHandshake: getLastHandshakeDate(client) || null,
        handshakeState: getHandshakeState(client),
        transferRx: client.transferRx || 0,
        transferTx: client.transferTx || 0,
        tunnelStatus: deriveConnectionStatus(router, client),
        peerCreatedAt: client.createdAt || null,
        interfaceName: client.interfaceName || null,
        endpoint: client.endpoint || null,
        allowedIPs: client.allowedIPs || router.vpnIp || null,
        persistentKeepalive: client.persistentKeepalive ?? null
    };
}

function resolvePrimaryTunnel(router, client, ownerTunnelContext) {
    return isManagementOnlyRouter(router)
        ? buildOwnerTunnelSummary(router, ownerTunnelContext)
        : buildDirectTunnelSummary(router, client);
}

function resolveTunnelPeerId(router, ownerRouters = []) {
    if (!router) return null;
    if (!isManagementOnlyRouter(router)) {
        return router.wireguardClientId?._id ? String(router.wireguardClientId._id) : (router.wireguardClientId ? String(router.wireguardClientId) : null);
    }
    const context = resolveOwnerTunnelContext(router, ownerRouters);
    return context?.client?._id ? String(context.client._id) : null;
}

function buildSharedTunnelDeviceEntry(router, ownerRouters = []) {
    const managementOnly = isManagementOnlyRouter(router);
    const client = managementOnly ? null : (router.wireguardClientId || null);
    const ownerTunnelContext = managementOnly ? resolveOwnerTunnelContext(router, ownerRouters) : null;
    const primaryTunnel = resolvePrimaryTunnel(router, client, ownerTunnelContext);

    return {
        routerId: String(router._id),
        routerName: router.name || null,
        connectionMode: router.connectionMode || 'wireguard',
        status: router.status,
        serverNode: primaryTunnel?.serverNode || (managementOnly ? 'management-only' : (router.serverNode || 'wireguard')),
        vpnIp: primaryTunnel?.vpnIp || router.vpnIp || router.discoveryInfo?.localAddress || null,
        peerName: primaryTunnel?.peerName || null,
        peerEnabled: primaryTunnel?.peerEnabled ?? false,
        lastHandshake: primaryTunnel?.lastHandshake || null,
        handshakeState: primaryTunnel?.handshakeState || (managementOnly ? 'management_only' : 'never'),
        tunnelStatus: primaryTunnel?.tunnelStatus || (managementOnly ? 'management_only' : deriveConnectionStatus(router, client)),
        transferRx: primaryTunnel?.transferRx || 0,
        transferTx: primaryTunnel?.transferTx || 0,
        sourceRouterId: primaryTunnel?.sourceRouterId || null,
        sourceRouterName: primaryTunnel?.sourceRouterName || null
    };
}

function buildWireGuardWorkspace(bundle, ownerTunnelContext = null) {
    const { router, client, ownerRouters = [] } = bundle;
    const managementOnly = isManagementOnlyRouter(router);
    const primaryTunnel = resolvePrimaryTunnel(router, client, ownerTunnelContext);
    const trackingSource = resolveTrackedRuntimeSource(router, ownerRouters);
    const primaryPeerId = primaryTunnel?.peerId || null;
    const sharedDevices = !primaryPeerId
        ? []
        : ownerRouters
            .filter((candidate) => String(candidate._id) !== String(router._id))
            .filter((candidate) => resolveTunnelPeerId(candidate, ownerRouters) === primaryPeerId)
            .map((candidate) => buildSharedTunnelDeviceEntry(candidate, ownerRouters));

    return {
        mode: managementOnly ? 'owner_tunnel' : 'router_tunnel',
        available: Boolean(primaryTunnel),
        primaryTunnel,
        trackingSource,
        sharedDevices,
        sharedDeviceCount: sharedDevices.length,
        runtime: null
    };
}

function normalizeWireGuardInterfaceRecord(record = {}) {
    return {
        id: record['.id'] || null,
        name: record.name || null,
        listenPort: record['listen-port'] ? Number(record['listen-port']) : null,
        mtu: record.mtu ? Number(record.mtu) : null,
        privateKeyConfigured: Boolean(record['private-key']),
        publicKey: record['public-key'] || null,
        disabled: String(record.disabled || '').toLowerCase() === 'true' || String(record.disabled || '').toLowerCase() === 'yes',
        running: String(record.running || '').toLowerCase() === 'true' || String(record.running || '').toLowerCase() === 'yes'
    };
}

function normalizeWireGuardPeerRecord(record = {}) {
    return {
        id: record['.id'] || null,
        interface: record.interface || null,
        publicKey: record['public-key'] || null,
        endpointAddress: record['endpoint-address'] || null,
        endpointPort: record['endpoint-port'] ? Number(record['endpoint-port']) : null,
        currentEndpointAddress: record['current-endpoint-address'] || null,
        currentEndpointPort: record['current-endpoint-port'] ? Number(record['current-endpoint-port']) : null,
        allowedAddress: record['allowed-address'] || null,
        persistentKeepalive: record['persistent-keepalive'] ? Number(record['persistent-keepalive']) : null,
        lastHandshake: record['last-handshake'] || null,
        rx: record['rx'] ? Number(record['rx']) : 0,
        tx: record['tx'] ? Number(record['tx']) : 0,
        disabled: String(record.disabled || '').toLowerCase() === 'true' || String(record.disabled || '').toLowerCase() === 'yes'
    };
}

async function fetchRouterWireGuardRuntime(routerId) {
    try {
        const [interfacesResult, peersResult] = await Promise.all([
            executeRouterOperation(routerId, 'get_system_resource', { command: '/interface/wireguard/print' }, { actor: 'system', actorType: 'system' }),
            executeRouterOperation(routerId, 'get_system_resource', { command: '/interface/wireguard/peers/print' }, { actor: 'system', actorType: 'system' })
        ]);

        const interfaces = Array.isArray(interfacesResult?.data) ? interfacesResult.data.map(normalizeWireGuardInterfaceRecord) : [];
        const peers = Array.isArray(peersResult?.data) ? peersResult.data.map(normalizeWireGuardPeerRecord) : [];

        return {
            available: interfaces.length > 0 || peers.length > 0,
            interfaces,
            peers,
            error: null
        };
    } catch (error) {
        return {
            available: false,
            interfaces: [],
            peers: [],
            error: error.message || 'Failed to query RouterOS WireGuard state'
        };
    }
}

function buildRuntimePeerTrackingMarker(sourceRouterId, peerPublicKey) {
    return `[tracked-wireguard-peer sourceRouter=${String(sourceRouterId || '').trim()} peerPublicKey=${String(peerPublicKey || '').trim()}]`;
}

function parseRuntimePeerTrackingMetadata(notes = '') {
    const body = String(notes || '');
    const markerMatch = body.match(/\[tracked-wireguard-peer\s+sourceRouter=([^\s\]]+)\s+peerPublicKey=([^\]]+)\]/);
    if (!markerMatch) return null;

    const readLineValue = (label) => {
        const lineMatch = body.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
        return lineMatch ? lineMatch[1].trim() : null;
    };

    return {
        sourceRouterId: markerMatch[1] || null,
        peerPublicKey: markerMatch[2] || null,
        peerName: readLineValue('Runtime peer'),
        allowedAddress: readLineValue('Allowed address'),
        endpoint: readLineValue('Endpoint'),
        reason: readLineValue('Reason')
    };
}

function getRuntimePeerTrackingMarker(router, peer) {
    if (!router?._id || !peer?.publicKey) return null;
    return buildRuntimePeerTrackingMarker(router._id, peer.publicKey);
}

function getTrackedRuntimePeerRouters(router, peer, ownerRouters = []) {
    const marker = getRuntimePeerTrackingMarker(router, peer);
    if (!marker) return [];

    return (ownerRouters || [])
        .filter((candidate) => String(candidate?._id || '') !== String(router?._id || ''))
        .filter((candidate) => String(candidate?.notes || '').includes(marker));
}

function buildTrackedRuntimePeerDeviceEntry(candidate) {
    const trackingSource = resolveTrackedRuntimeSource(candidate);
    return {
        routerId: String(candidate._id),
        routerName: candidate.name || null,
        connectionMode: candidate.connectionMode || 'management_only',
        status: candidate.status || 'inactive',
        serverNode: candidate.serverNode || 'management-only',
        vpnIp: candidate.vpnIp || candidate.discoveryInfo?.localAddress || null,
        localAddress: candidate.discoveryInfo?.localAddress || null,
        hostname: candidate.discoveryInfo?.hostname || null,
        source: candidate.discoveryInfo?.source || null,
        lastSeen: candidate.lastSeen || null,
        sourceRouterId: trackingSource?.sourceRouterId || null,
        sourceRouterName: trackingSource?.sourceRouterName || null
    };
}

function resolveTrackedRuntimeSource(router, ownerRouters = []) {
    const metadata = parseRuntimePeerTrackingMetadata(router?.notes || '');
    if (!metadata?.sourceRouterId) return null;

    const sourceRouter = (ownerRouters || []).find((candidate) => String(candidate?._id || '') === String(metadata.sourceRouterId));
    return {
        sourceRouterId: metadata.sourceRouterId,
        sourceRouterName: sourceRouter?.name || null,
        peerPublicKey: metadata.peerPublicKey || null,
        peerName: metadata.peerName || null,
        allowedAddress: metadata.allowedAddress || null,
        endpoint: metadata.endpoint || null,
        reason: metadata.reason || null
    };
}

async function resolveUniqueRouterName(userId, requestedName) {
    const baseName = String(requestedName || '').trim();
    if (!baseName) {
        throw new Error('Router name is required');
    }

    const existingRouters = await MikrotikRouter.find({ userId }, { name: 1 }).lean();
    const existingNames = new Set(existingRouters.map((item) => String(item.name || '').trim().toLowerCase()).filter(Boolean));
    if (!existingNames.has(baseName.toLowerCase())) {
        return baseName;
    }

    for (let suffix = 2; suffix <= 9999; suffix += 1) {
        const candidate = `${baseName}-${suffix}`;
        if (!existingNames.has(candidate.toLowerCase())) {
            return candidate;
        }
    }

    throw new Error('Unable to allocate a unique router name');
}

function enrichRuntimePeersWithTracking(router, runtime, ownerRouters = []) {
    if (!runtime || !Array.isArray(runtime.peers)) {
        return runtime;
    }

    return {
        ...runtime,
        peers: runtime.peers.map((peer) => {
            const trackedDevices = getTrackedRuntimePeerRouters(router, peer, ownerRouters)
                .map((candidate) => buildTrackedRuntimePeerDeviceEntry(candidate));
            return {
                ...peer,
                trackedDevices,
                trackedDeviceCount: trackedDevices.length,
                trackingMarker: getRuntimePeerTrackingMarker(router, peer)
            };
        })
    };
}

function buildRuntimePeerTrackedNote(router, runtimePeer, reason = '') {
    const marker = getRuntimePeerTrackingMarker(router, runtimePeer);
    const endpoint = runtimePeer.currentEndpointAddress || runtimePeer.endpointAddress || 'unknown';
    const endpointPort = runtimePeer.currentEndpointPort || runtimePeer.endpointPort || null;
    const peerName = runtimePeer.interface || runtimePeer.publicKey || 'runtime-peer';
    const noteLines = [
        marker,
        `Tracked from router ${router.name || router._id} (${router._id})`,
        `Runtime peer: ${peerName}`,
        `Public key: ${runtimePeer.publicKey || 'unknown'}`,
        `Allowed address: ${runtimePeer.allowedAddress || 'unknown'}`,
        `Endpoint: ${endpoint}${endpointPort ? `:${endpointPort}` : ''}`
    ];

    if (reason) {
        noteLines.push(`Reason: ${reason}`);
    }

    return noteLines.join('\n');
}

async function trackRouterRuntimePeer({ routerId, peerId, name, reason = '', actor = 'admin' }) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) {
        throw new Error('Router not found');
    }

    const { router, ownerRouters = [] } = bundle;
    const runtime = await fetchRouterWireGuardRuntime(String(router._id));
    const runtimePeer = (runtime?.peers || []).find((peer) => String(peer.id || '') === String(peerId || ''));

    if (!runtime.available || !runtimePeer) {
        throw new Error('Runtime WireGuard peer not found');
    }

    if (!runtimePeer.publicKey) {
        throw new Error('Runtime WireGuard peer is missing a public key');
    }

    const existingTrackedRouters = getTrackedRuntimePeerRouters(router, runtimePeer, ownerRouters);
    if (existingTrackedRouters.length) {
        const error = new Error('A managed router already tracks this runtime peer');
        error.code = 'runtime_peer_already_tracked';
        error.routerIds = existingTrackedRouters.map((candidate) => String(candidate._id));
        throw error;
    }

    const uniqueName = await resolveUniqueRouterName(bundle.owner._id, name);

    const created = await createManagementOnlyRouterAdmin({
        userId: String(bundle.owner._id),
        name: uniqueName,
        notes: buildRuntimePeerTrackedNote(router, runtimePeer, reason)
    });

    created.router.discoveryInfo = {
        ...(created.router.discoveryInfo || {}),
        hostname: runtimePeer.interface || created.router.discoveryInfo?.hostname || null,
        localAddress: runtimePeer.currentEndpointAddress || runtimePeer.endpointAddress || null,
        source: 'wireguard_runtime'
    };
    created.router.adminNotes = [
        ...(created.router.adminNotes || []),
        {
            body: `Tracked runtime WireGuard peer ${runtimePeer.interface || runtimePeer.publicKey || peerId} from source router ${router.name || router._id}.`,
            category: 'infrastructure',
            pinned: false,
            author: actor,
            createdAt: new Date()
        }
    ];
    router.adminNotes = [
        ...(router.adminNotes || []),
        {
            body: `Runtime WireGuard peer ${runtimePeer.interface || runtimePeer.publicKey || peerId} was tracked as management-only router ${created.router.name}.`,
            category: 'infrastructure',
            pinned: false,
            author: actor,
            createdAt: new Date()
        }
    ];
    await router.save();
    await created.router.save();

    return {
        sourceRouter: router,
        runtime,
        runtimePeer,
        requestedName: name,
        createdRouter: created.router,
        trackedDevices: [buildTrackedRuntimePeerDeviceEntry(created.router)]
    };
}

function deriveSetupStatus(router, client) {
    if (isManagementOnlyRouter(router)) {
        if (router.status === 'inactive') return 'disabled';
        if (router.provisioningError) return 'failed';
        if (router.lastApiSuccessAt || router.status === 'active') return 'managed';
        return 'management_only';
    }
    if (!client) return 'failed';
    if (router.status === 'inactive') return 'disabled';
    if (router.firstConnectedAt) return 'connected';
    if (router.provisioningError) return 'failed';
    if (router.lastSetupGeneratedAt || client.createdAt) return 'awaiting_connection';
    return 'pending';
}

function deriveConnectionStatus(router, client) {
    if (isManagementOnlyRouter(router)) {
        if (router.status === 'inactive') return 'disabled';
        if (router.status === 'offline') return 'offline';
        return router.lastApiSuccessAt || router.status === 'active' ? 'online' : 'pending';
    }
    if (router.status === 'inactive') return 'disabled';
    if (!client || !client.enabled) return 'peer_disabled';
    if (router.status === 'active') return 'online';
    if (router.status === 'offline') return 'offline';
    return 'pending';
}

function deriveHealthSummary(router, client) {
    const issues = [];
    const handshakeState = getHandshakeState(client);
    const managementOnly = isManagementOnlyRouter(router);

    if (!managementOnly && (!router.ports?.winbox || !router.ports?.ssh || !router.ports?.api)) {
        issues.push('missing_ports');
    }
    if (!managementOnly && !client) {
        issues.push('missing_peer');
    }
    if (!managementOnly && client && !client.enabled) {
        issues.push('peer_disabled');
    }
    if (router.status === 'offline') {
        issues.push('router_offline');
    }
    if (!managementOnly && handshakeState === 'never') {
        issues.push('no_handshake');
    }
    if (!managementOnly && handshakeState === 'stale') {
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
    const managementOnly = isManagementOnlyRouter(router);

    return {
        winbox: {
            publicPort: ports.winbox || null,
            targetPort: 8291,
            allocationStatus: managementOnly ? 'not_required' : (ports.winbox ? 'assigned' : 'missing'),
            forwardingStatus: managementOnly ? 'not_required' : (proxyStatus.running ? (proxyStatus.winbox?.listening ? 'listening' : 'not_listening') : 'stopped')
        },
        ssh: {
            publicPort: ports.ssh || null,
            targetPort: 22,
            allocationStatus: managementOnly ? 'not_required' : (ports.ssh ? 'assigned' : 'missing'),
            forwardingStatus: managementOnly ? 'not_required' : (proxyStatus.running ? (proxyStatus.ssh?.listening ? 'listening' : 'not_listening') : 'stopped')
        },
        api: {
            publicPort: ports.api || null,
            targetPort: 8728,
            allocationStatus: managementOnly ? 'not_required' : (ports.api ? 'assigned' : 'missing'),
            forwardingStatus: managementOnly ? 'not_required' : (proxyStatus.running ? (proxyStatus.api?.listening ? 'listening' : 'not_listening') : 'stopped')
        },
        proxyStatus
    };
}

function buildMonitoringSummary(router, client, ownerTunnelContext = null) {
    const lastHandshake = getLastHandshakeDate(client);
    const health = deriveHealthSummary(router, client);
    const managementOnly = isManagementOnlyRouter(router);
    const ownerTunnel = managementOnly ? buildOwnerTunnelSummary(router, ownerTunnelContext) : null;

    return {
        online: router.status === 'active',
        status: router.status,
        lastSeen: router.lastSeen || null,
        lastHandshake: managementOnly ? null : (lastHandshake || null),
        handshakeState: managementOnly ? 'management_only' : getHandshakeState(client),
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
        health,
        ownerTunnel
    };
}

function buildConnectivitySummary(router, client, ownerTunnelContext = null) {
    const lastHandshake = getLastHandshakeDate(client);
    const managementOnly = isManagementOnlyRouter(router);
    const ownerTunnel = managementOnly ? buildOwnerTunnelSummary(router, ownerTunnelContext) : null;
    return {
        connectionMode: router.connectionMode || 'wireguard',
        managementMode: router.managementMode || (managementOnly ? 'management_only' : 'fully_managed'),
        peerId: client ? String(client._id) : null,
        peerEnabled: Boolean(client?.enabled),
        peerName: client?.name || null,
        serverNode: managementOnly ? 'management-only' : (router.serverNode || 'wireguard'),
        vpnIp: router.vpnIp || router.discoveryInfo?.localAddress || null,
        allowedIPs: managementOnly ? [] : (client?.allowedIPs || router.vpnIp),
        publicKeyFingerprint: formatPublicKeyFingerprint(client?.publicKey),
        tunnelStatus: managementOnly ? 'management_only' : deriveConnectionStatus(router, client),
        lastHandshake: managementOnly ? null : (lastHandshake || null),
        handshakeState: managementOnly ? 'management_only' : getHandshakeState(client),
        transferRx: client?.transferRx || 0,
        transferTx: client?.transferTx || 0,
        peerCreatedAt: client?.createdAt || null,
        configGenerationStatus: managementOnly ? 'not_required' : (router.lastSetupGeneratedAt ? 'generated' : (client ? 'available' : 'missing')),
        rekeyEligible: managementOnly ? false : Boolean(client),
        reconciliationState: managementOnly ? 'management_only' : (client ? (client.enabled ? 'managed' : 'disabled') : 'missing'),
        endpointHealthSummary: router.endpointHealthSummary || 'unknown',
        ownerTunnel,
        endpoints: (router.managementEndpoints || []).map((endpoint) => ({
            id: endpoint.id,
            kind: endpoint.kind,
            host: endpoint.host,
            port: endpoint.port,
            transport: endpoint.transport,
            priority: endpoint.priority,
            enabled: endpoint.enabled !== false,
            health: endpoint.health || 'unknown',
            authScope: endpoint.authScope || 'unknown',
            lastSuccessAt: endpoint.lastSuccessAt || null,
            lastFailureAt: endpoint.lastFailureAt || null,
            failureType: endpoint.failureType || null,
            latencyMs: endpoint.latencyMs || null
        }))
    };
}

function buildApiAccessSummary(router) {
    const preferredEndpoint = (router.managementEndpoints || [])
        .filter((endpoint) => endpoint.enabled !== false && ['api', 'api_ssl', 'rest_https'].includes(endpoint.transport))
        .sort((a, b) => (a.priority || 999) - (b.priority || 999))[0];
    const hasCredentials = Boolean(router.credentialState?.secretRef || (router.apiUsername || '').trim() || (router.apiPassword || '').trim());
    const lastSuccessAt = router.lastApiSuccessAt || null;
    const lastErrorAt = router.lastApiErrorAt || null;
    return {
        username: router.apiUsername || 'admin',
        apiPort: preferredEndpoint?.port || router.apiPort || 8728,
        hasPassword: Boolean(router.apiPassword),
        hasCredentials,
        credentialState: {
            secretConfigured: Boolean(router.credentialState?.secretRef),
            state: router.credentialState?.state || (hasCredentials ? 'active' : 'unknown'),
            lastVerifiedAt: router.credentialState?.lastVerifiedAt || null,
            lastRotatedAt: router.credentialState?.lastRotatedAt || null,
            nextRotationDueAt: router.credentialState?.nextRotationDueAt || null,
            verificationFailureCount: Number(router.credentialState?.verificationFailureCount || 0)
        },
        routerosVersion: router.routerosVersion || router.routerboardInfo?.firmware || null,
        lastSuccessAt,
        lastErrorAt,
        lastError: router.lastApiError || null,
        state: lastSuccessAt ? 'healthy' : (lastErrorAt ? 'failing' : (hasCredentials ? 'pending' : 'unconfigured'))
    };
}

function normalizePingHistoryItem(item = {}) {
    return {
        target: item.target || '',
        reachable: Boolean(item.reachable),
        packetsSent: item.packetsSent ?? null,
        packetsReceived: item.packetsReceived ?? null,
        packetLoss: item.packetLoss ?? null,
        avgRtt: item.avgRtt ?? null,
        error: item.error || null,
        actor: item.actor || 'system',
        createdAt: item.createdAt || null
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
    const ownerRoutersByUser = routers.reduce((map, router) => {
        const key = String(router.userId?._id || router.userId || '');
        if (!key) return map;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(router);
        return map;
    }, new Map());
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
        supportSummaryByUser,
        ownerRoutersByUser
    };
}

function buildRouterListItem(router, related) {
    const owner = router.userId;
    const client = router.wireguardClientId || null;
    const ownerTunnelContext = isManagementOnlyRouter(router)
        ? resolveOwnerTunnelContext(router, related.ownerRoutersByUser.get(String(owner?._id || owner || '')) || [])
        : null;
    const ownerTunnel = isManagementOnlyRouter(router) ? buildOwnerTunnelSummary(router, ownerTunnelContext) : null;
    const subscription = related.subscriptionsByRouterId.get(String(router._id)) || null;
    const health = deriveHealthSummary(router, client);
    const monitoring = buildMonitoringSummary(router, client);

    return {
        id: String(router._id),
        name: router.name,
        customer: owner ? buildCustomerSummary(owner, related.userRouterCounts.get(String(owner._id)) || 0, null, subscription) : null,
        status: router.status,
        connectionMode: router.connectionMode || 'wireguard',
        managementMode: router.managementMode || (router.connectionMode === 'management_only' ? 'management_only' : 'fully_managed'),
        setupStatus: deriveSetupStatus(router, client),
        connectionStatus: deriveConnectionStatus(router, client),
        vpnIp: isManagementOnlyRouter(router)
            ? (ownerTunnel?.vpnIp || router.vpnIp || router.discoveryInfo?.localAddress || null)
            : (router.vpnIp || router.discoveryInfo?.localAddress || null),
        serverNode: isManagementOnlyRouter(router)
            ? (ownerTunnel?.serverNode || 'management-only')
            : (router.serverNode || 'wireguard'),
        winboxPort: router.ports?.winbox || null,
        sshPort: router.ports?.ssh || null,
        apiPort: router.ports?.api || null,
        location: router.routerboardInfo?.boardName || router.routerboardInfo?.model || router.discoveryInfo?.hostname || null,
        lastSeen: router.lastSeen || null,
        lastHandshake: isManagementOnlyRouter(router) ? (ownerTunnel?.lastHandshake || null) : getLastHandshakeDate(client),
        healthSummary: health,
        createdAt: router.createdAt,
        billingState: subscription?.status || 'none',
        issueFlags: (router.internalFlags || []).map((flag) => flag.flag),
        unhealthy: monitoring.health.state !== 'healthy',
        apiConnectivity: buildApiAccessSummary(router),
        ownerTunnel,
        endpointHealthSummary: router.endpointHealthSummary || 'unknown',
        capabilitySummary: {
            interfacesRead: Boolean(router.capabilities?.interfacesRead),
            queuesRead: Boolean(router.capabilities?.queuesRead),
            hotspotRead: Boolean(router.capabilities?.hotspotRead),
            pppoeRead: Boolean(router.capabilities?.pppoeRead),
            firewallRead: Boolean(router.capabilities?.firewallRead),
            routesRead: Boolean(router.capabilities?.routesRead),
            wireguardRead: Boolean(router.capabilities?.wireguardRead)
        }
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
        routersWithoutPorts: items.filter((item) => item.connectionMode !== 'management_only' && (!item.winboxPort || !item.sshPort || !item.apiPort)).length,
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
        MikrotikRouter.find({ userId: router.userId?._id || router.userId }).populate('wireguardClientId').lean(),
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
    let summary = entry.reason ? `${entry.action}: ${entry.reason}` : entry.action;
    if (entry.action === 'admin_track_router_runtime_peer') {
        const sourceRouterName = entry.metadata?.sourceRouterName || entry.metadata?.sourceRouterId || 'source router';
        const interfaceName = entry.metadata?.runtimePeerInterface || 'runtime peer';
        summary = `Tracked ${interfaceName} from ${sourceRouterName}`;
    }
    return {
        id: String(entry._id),
        type: 'admin_action',
        source: 'admin',
        actor: entry.actorUserId?.email || entry.actorUserId?.name || 'admin',
        action: entry.action,
        summary,
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

    (router.adminNotes || []).forEach((note) => {
        events.push({
            id: `router-note-${router._id}-${note._id || note.createdAt}`,
            type: 'note_added',
            source: 'notes',
            actor: note.author || 'system',
            summary: note.body,
            metadata: {
                category: note.category || 'support',
                pinned: Boolean(note.pinned)
            },
            timestamp: note.createdAt
        });
    });

    auditLogs.forEach((entry) => {
        events.push(formatAuditEvent(entry));
    });

    return events.filter((item) => Boolean(item.timestamp)).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function buildProvisioningSummary(bundle) {
    const { router, client } = bundle;
    const managementOnly = isManagementOnlyRouter(router);
    return {
        state: deriveSetupStatus(router, client),
        configGenerationStatus: managementOnly ? 'not_required' : (client ? 'available' : 'missing_peer'),
        provisioningError: router.provisioningError || null,
        assignedResources: {
            vpnIp: router.vpnIp,
            localAddress: router.discoveryInfo?.localAddress || null,
            serverNode: managementOnly ? 'management-only' : (router.serverNode || 'wireguard'),
            ports: router.ports,
            openPorts: router.discoveryInfo?.openPorts || []
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
    const managementOnly = isManagementOnlyRouter(router);

    if (!managementOnly && !client) issues.push({ code: 'missing_peer', severity: 'critical', message: 'Router does not have a linked WireGuard client.' });
    if (!managementOnly && client && router.vpnIp !== client.ip) issues.push({ code: 'vpn_ip_mismatch', severity: 'critical', message: 'Router VPN IP does not match linked WireGuard client IP.' });
    if (!managementOnly && (!router.ports?.winbox || !router.ports?.ssh || !router.ports?.api)) issues.push({ code: 'missing_ports', severity: 'critical', message: 'Router is missing one or more public access ports.' });
    if (!managementOnly && client && !client.enabled) issues.push({ code: 'peer_disabled', severity: 'warning', message: 'Linked WireGuard peer is disabled.' });
    if (router.status === 'offline') issues.push({ code: 'router_offline', severity: 'warning', message: 'Router is marked offline.' });
    if (!managementOnly && getHandshakeState(client) === 'never') issues.push({ code: 'no_handshake', severity: 'warning', message: 'Router has not reported a WireGuard handshake yet.' });
    if (!managementOnly && getHandshakeState(client) === 'stale') issues.push({ code: 'stale_handshake', severity: 'warning', message: 'Router handshake is stale.' });
    if (!managementOnly && router.status !== 'inactive' && !proxyStatus.running) issues.push({ code: 'proxy_not_running', severity: 'warning', message: 'Router TCP proxy is not currently running.' });
    if (!managementOnly && !subscription) issues.push({ code: 'missing_subscription', severity: 'warning', message: 'Router does not have an associated subscription.' });
    if (router.provisioningError) issues.push({ code: 'provisioning_error', severity: 'critical', message: router.provisioningError });

    return {
        status: issues.some((issue) => issue.severity === 'critical') ? 'critical' : (issues.length ? 'warning' : 'healthy'),
        issues,
        proxyStatus,
        recommendedActions: [
            !managementOnly && issues.some((issue) => issue.code === 'missing_ports') ? 'reassign_ports' : null,
            !managementOnly && issues.some((issue) => issue.code === 'missing_peer') ? 'reprovision' : null,
            !managementOnly && issues.some((issue) => issue.code === 'stale_handshake') ? 'reset_peer' : null,
            !managementOnly && issues.some((issue) => issue.code === 'proxy_not_running') ? 'reactivate' : null
        ].filter(Boolean)
    };
}

async function getAdminRouterDetail(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;

    const { router, client, owner, subscription, ownerRouters } = bundle;
    const ownerTunnelContext = isManagementOnlyRouter(router) ? resolveOwnerTunnelContext(router, ownerRouters) : null;
    const monitoring = buildMonitoringSummary(router, client, ownerTunnelContext);
    const activity = buildRouterActivity(bundle);
    const wireguard = buildWireGuardWorkspace(bundle, ownerTunnelContext);
    const downstreamDiscovery = await getLatestDownstreamDiscoveryRun(router._id).catch(() => null);
    wireguard.runtime = await fetchRouterWireGuardRuntime(String(router._id));
    if (!wireguard.available && wireguard.runtime?.available && wireguard.runtime.peers.length) {
        const runtimePeer = wireguard.runtime.peers[0];
        wireguard.available = true;
        wireguard.mode = 'router_tunnel';
        wireguard.primaryTunnel = {
            source: 'router_runtime',
            sourceRouterId: String(router._id),
            sourceRouterName: router.name || null,
            peerId: runtimePeer.id || `runtime-${runtimePeer.publicKey || 'peer'}`,
            peerName: runtimePeer.interface || runtimePeer.publicKey || 'runtime peer',
            peerEnabled: !runtimePeer.disabled,
            serverNode: router.serverNode || 'management-only',
            vpnIp: router.vpnIp || router.discoveryInfo?.localAddress || null,
            publicKeyFingerprint: formatPublicKeyFingerprint(runtimePeer.publicKey),
            lastHandshake: null,
            handshakeState: runtimePeer.lastHandshake || 'unknown',
            transferRx: runtimePeer.rx || 0,
            transferTx: runtimePeer.tx || 0,
            tunnelStatus: runtimePeer.disabled ? 'peer_disabled' : 'healthy',
            peerCreatedAt: null,
            interfaceName: runtimePeer.interface || null,
            endpoint: runtimePeer.endpointAddress
                ? `${runtimePeer.endpointAddress}${runtimePeer.endpointPort ? `:${runtimePeer.endpointPort}` : ''}`
                : null,
            allowedIPs: runtimePeer.allowedAddress || null,
            persistentKeepalive: runtimePeer.persistentKeepalive ?? null
        };
    }
    wireguard.runtime = enrichRuntimePeersWithTracking(router, wireguard.runtime, ownerRouters);

    return {
        id: String(router._id),
        profile: {
            id: String(router._id),
            name: router.name,
            vpnIp: router.vpnIp,
            connectionMode: router.connectionMode || 'wireguard',
            managementMode: router.managementMode || (router.connectionMode === 'management_only' ? 'management_only' : 'fully_managed'),
            serverNode: router.serverNode || 'wireguard',
            status: router.status,
            setupStatus: deriveSetupStatus(router, client),
            connectionStatus: deriveConnectionStatus(router, client),
            localAddress: router.discoveryInfo?.localAddress || null,
            hostname: router.discoveryInfo?.hostname || null,
            macAddress: router.discoveryInfo?.macAddress || null,
            discoverySource: router.discoveryInfo?.source || null,
            openPorts: router.discoveryInfo?.openPorts || [],
            boardName: router.routerboardInfo?.boardName || null,
            model: router.routerboardInfo?.model || null,
            serialNumber: router.routerboardInfo?.serialNumber || null,
            routerosVersion: router.routerosVersion || router.routerboardInfo?.firmware || null,
            createdAt: router.createdAt,
            updatedAt: router.updatedAt
        },
        policy: {
            defaultMaxClass: router.safetyPolicy?.defaultMaxClass || 'read_only',
            allowNetworkCoreWrites: Boolean(router.safetyPolicy?.allowNetworkCoreWrites),
            allowBootstrap: Boolean(router.safetyPolicy?.allowBootstrap),
            approvedScopes: router.safetyPolicy?.approvedScopes || [],
            breakGlassRequiredFor: router.safetyPolicy?.breakGlassRequiredFor || []
        },
        capabilities: {
            probedAt: router.capabilities?.probedAt || null,
            systemRead: Boolean(router.capabilities?.systemRead),
            identityRead: Boolean(router.capabilities?.identityRead),
            interfacesRead: Boolean(router.capabilities?.interfacesRead),
            queuesRead: Boolean(router.capabilities?.queuesRead),
            hotspotRead: Boolean(router.capabilities?.hotspotRead),
            pppoeRead: Boolean(router.capabilities?.pppoeRead),
            firewallRead: Boolean(router.capabilities?.firewallRead),
            routesRead: Boolean(router.capabilities?.routesRead),
            wireguardRead: Boolean(router.capabilities?.wireguardRead),
            logsRead: Boolean(router.capabilities?.logsRead),
            queueWrite: Boolean(router.capabilities?.queueWrite),
            hotspotWrite: Boolean(router.capabilities?.hotspotWrite),
            pppoeWrite: Boolean(router.capabilities?.pppoeWrite),
            firewallWrite: Boolean(router.capabilities?.firewallWrite),
            routesWrite: Boolean(router.capabilities?.routesWrite),
            interfaceWrite: Boolean(router.capabilities?.interfaceWrite),
            wireguardWrite: Boolean(router.capabilities?.wireguardWrite),
            reboot: Boolean(router.capabilities?.reboot)
        },
        customer: owner ? buildCustomerSummary(owner, ownerRouters.length, null, subscription) : null,
        accessPorts: buildPortsSummary(router),
        connectivity: buildConnectivitySummary(router, client, ownerTunnelContext),
        discovery: {
            localAddress: router.discoveryInfo?.localAddress || null,
            subnet: router.discoveryInfo?.subnet || null,
            hostname: router.discoveryInfo?.hostname || null,
            macAddress: router.discoveryInfo?.macAddress || null,
            source: router.discoveryInfo?.source || null,
            openPorts: router.discoveryInfo?.openPorts || [],
            importedAt: router.discoveryInfo?.importedAt || null
        },
        apiAccess: buildApiAccessSummary(router),
        pingHistory: (router.pingHistory || [])
            .slice()
            .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
            .slice(0, 10)
            .map(normalizePingHistoryItem),
        failureState: {
            current: router.failureState?.current || null,
            firstFailedAt: router.failureState?.firstFailedAt || null,
            lastFailedAt: router.failureState?.lastFailedAt || null,
            lastError: router.failureState?.lastError || null,
            failingEndpointId: router.failureState?.failingEndpointId || null,
            failingTransport: router.failureState?.failingTransport || null
        },
        monitoring,
        wireguard,
        downstreamDiscovery,
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
    const ownerTunnelContext = isManagementOnlyRouter(bundle.router) ? resolveOwnerTunnelContext(bundle.router, bundle.ownerRouters) : null;
    return buildConnectivitySummary(bundle.router, bundle.client, ownerTunnelContext);
}

async function getAdminRouterPorts(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    return buildPortsSummary(bundle.router);
}

async function getAdminRouterMonitoring(routerId) {
    const bundle = await getRouterBundle(routerId);
    if (!bundle) return null;
    const ownerTunnelContext = isManagementOnlyRouter(bundle.router) ? resolveOwnerTunnelContext(bundle.router, bundle.ownerRouters) : null;
    return buildMonitoringSummary(bundle.router, bundle.client, ownerTunnelContext);
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

async function createRouterAdmin({ userId, name, serverNode = 'wireguard', notes = '', dbInitialized = true }) {
    const owner = await User.findById(userId);
    if (!owner || owner.role !== 'user') {
        throw new Error('Target user not found');
    }

    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
        throw new Error('Router name is required');
    }

    const existingRouter = await MikrotikRouter.findOne({ userId: owner._id, name: trimmedName }).lean();
    if (existingRouter) {
        throw new Error('A router with this name already exists for the selected customer');
    }

    const ports = await allocatePorts();
    let wireguardClient = null;
    let router = null;
    try {
        wireguardClient = await createWireGuardClientRecord({
            name: `router-${trimmedName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${owner._id}`,
            notes: `MikroTik router: ${trimmedName}`,
            createdBy: String(owner._id),
            dbInitialized
        });

        try {
            await attachPeerToWireGuard(wireguardClient);
        } catch (error) {
            // Keep parity with existing flows: peer add failures should not block creation.
        }

        router = new MikrotikRouter({
            userId: owner._id,
            name: trimmedName,
            wireguardClientId: wireguardClient._id,
            vpnIp: wireguardClient.ip,
            connectionMode: 'wireguard',
            managementMode: 'fully_managed',
            serverNode: String(serverNode || 'wireguard').trim() || 'wireguard',
            ports,
            status: 'pending',
            lastSetupGeneratedAt: new Date(),
            lastReconfiguredAt: new Date(),
            notes: notes || '',
            safetyPolicy: {
                defaultMaxClass: 'network_core_mutation',
                allowPublicEndpointWrites: false,
                allowNetworkCoreWrites: true,
                allowBootstrap: true,
                breakGlassRequiredFor: ['bootstrap_mutation'],
                approvedScopes: ['queues', 'hotspot', 'pppoe', 'firewall', 'routes', 'interfaces']
            }
        });

        await router.save();

        try {
            await createSubscription(owner._id, router._id);
        } catch (error) {
            if (!isInsufficientBalanceError(error)) {
                throw error;
            }

            await createPastDueSubscription(owner._id, router._id, error.message);
            router.adminNotes = [
                ...(router.adminNotes || []),
                {
                    body: `Router created by admin with billing hold: ${error.message}`,
                    category: 'billing',
                    pinned: true,
                    author: 'system'
                }
            ];
            await router.save();
        }

        try {
            await startRouterProxy(router._id);
        } catch (error) {
            // Allow creation to succeed even if proxy bootstrap fails.
        }

        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = getServerEndpoint();

        return {
            router,
            client: wireguardClient,
            owner,
            artifacts: {
                wireguardConfig: buildWireGuardConfig(wireguardClient, serverPublicKey, serverEndpoint)
            }
        };
    } catch (error) {
        if (router?._id) {
            await MikrotikRouter.findByIdAndDelete(router._id).catch(() => undefined);
        }
        if (wireguardClient?._id) {
            await detachPeerFromWireGuard(wireguardClient).catch(() => undefined);
            await Client.findByIdAndDelete(wireguardClient._id).catch(() => undefined);
        }
        throw error;
    }
}

async function createManagementOnlyRouterAdmin({ userId, name, notes = '' }) {
    const owner = await User.findById(userId);
    if (!owner || owner.role !== 'user') {
        throw new Error('Target user not found');
    }

    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
        throw new Error('Router name is required');
    }

    const existingRouter = await MikrotikRouter.findOne({ userId: owner._id, name: trimmedName }).lean();
    if (existingRouter) {
        throw new Error('A router with this name already exists for the selected customer');
    }

    const router = new MikrotikRouter({
        userId: owner._id,
        name: trimmedName,
        vpnIp: null,
        connectionMode: 'management_only',
        managementMode: 'management_only',
        serverNode: 'management-only',
        ports: {},
        status: 'active',
        lastSeen: new Date(),
        notes: notes || '',
        safetyPolicy: {
            defaultMaxClass: 'service_mutation',
            allowPublicEndpointWrites: false,
            allowNetworkCoreWrites: false,
            allowBootstrap: false,
            breakGlassRequiredFor: ['service_mutation', 'network_core_mutation', 'bootstrap_mutation'],
            approvedScopes: ['queues']
        }
    });

    await router.save();

    return {
        router,
        client: null,
        owner,
        artifacts: null
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
    const client = await createWireGuardClientRecord({
        name: `router-${router.name.toLowerCase()}-${String(ownerId)}`,
        notes: `MikroTik router: ${router.name}`,
        createdBy: String(ownerId),
        dbInitialized,
        preferredIp: router.vpnIp || null
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
    if (router.ports?.winbox || router.ports?.ssh || router.ports?.api) {
        await releasePorts(router._id);
    }

    await RouterDiscoverySession.updateMany(
        {},
        {
            $unset: {
                'candidates.$[imported].importedRouterId': 1,
                'candidates.$[imported].importedAt': 1,
                'candidates.$[duplicate].verification.readiness.duplicateRouterId': 1
            },
            $set: {
                'candidates.$[imported].verification.status': 'verified',
                'candidates.$[duplicate].verification.status': 'verified'
            },
            $pull: {
                'candidates.$[duplicate].verification.readiness.reasons': 'Router appears to already be onboarded'
            }
        },
        {
            arrayFilters: [
                { 'imported.importedRouterId': router._id },
                { 'duplicate.verification.readiness.duplicateRouterId': router._id }
            ]
        }
    ).catch(() => undefined);

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
    createRouterAdmin,
    createManagementOnlyRouterAdmin,
    trackRouterRuntimePeer,
    generateRouterSetupArtifacts,
    disableRouter,
    reactivateRouter,
    resetRouterPeer,
    reprovisionRouter,
    reassignRouterPorts,
    markRouterProvisioningReviewed,
    deleteRouterAdmin
};
