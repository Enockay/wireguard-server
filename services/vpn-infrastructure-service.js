const { execFile } = require('child_process');
const { promisify } = require('util');
const VpnServer = require('../models/VpnServer');
const Client = require('../models/Client');
const MikrotikRouter = require('../models/MikrotikRouter');
const { loadClientsFromDatabase } = require('../utils/route-helpers');
const { wgLock, runWgCommand, getServerPublicKey, getServerEndpoint, log } = require('../wg-core');

const execFileAsync = promisify(execFile);
const LOCAL_NODE_ID = 'wireguard';

function parseWgDump(dump) {
    const lines = String(dump || '').trim().split('\n').filter(Boolean);
    const peers = [];

    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        peers.push({
            publicKey: parts[0],
            endpoint: parts[2],
            allowedIps: parts[3],
            lastHandshake: parts[4] && parts[4] !== '0' ? new Date(Number(parts[4]) * 1000) : null,
            transferRx: Number(parts[5] || 0),
            transferTx: Number(parts[6] || 0)
        });
    }

    return peers;
}

async function ensureLocalVpnServer() {
    const endpoint = getServerEndpoint();
    let publicKey = '';

    try {
        publicKey = await getServerPublicKey();
    } catch (error) {
        publicKey = '';
    }

    const server = await VpnServer.findOneAndUpdate(
        { nodeId: LOCAL_NODE_ID },
        {
            $set: {
                name: 'Primary WireGuard Server',
                region: process.env.SERVER_REGION || 'primary',
                hostname: endpoint.split(':')[0],
                endpoint,
                publicKey: publicKey || undefined,
                controlMode: 'local',
                enabled: true
            },
            $setOnInsert: {
                status: 'unknown'
            }
        },
        { upsert: true, new: true }
    );

    return server;
}

async function getLocalRuntimeMetrics() {
    let peers = [];
    let interfaceUp = false;
    let error = null;

    try {
        const dump = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
        peers = parseWgDump(dump);
        interfaceUp = true;
    } catch (runtimeError) {
        error = runtimeError.message;
    }

    const [clients, routers] = await Promise.all([
        Client.find({}).lean(),
        MikrotikRouter.find({ serverNode: LOCAL_NODE_ID }).populate('wireguardClientId').lean()
    ]);

    const activePeerCount = peers.filter((peer) => peer.lastHandshake && (Date.now() - new Date(peer.lastHandshake).getTime()) <= 180000).length;
    const clientByPublicKey = new Map(clients.map((client) => [String(client.publicKey || '').trim(), client]));
    const totalTransferRx = peers.reduce((sum, peer) => sum + (peer.transferRx || 0), 0);
    const totalTransferTx = peers.reduce((sum, peer) => sum + (peer.transferTx || 0), 0);

    return {
        interfaceUp,
        peers,
        activePeerCount,
        totalPeerCount: peers.length,
        totalTransferRx,
        totalTransferTx,
        routers,
        onlineRouters: routers.filter((router) => router.status === 'active').length,
        offlineRouters: routers.filter((router) => ['offline', 'inactive'].includes(router.status)).length,
        stalePeers: peers.filter((peer) => !peer.lastHandshake || (Date.now() - new Date(peer.lastHandshake).getTime()) > 180000).length,
        clientByPublicKey,
        error
    };
}

async function syncLocalServerHealth(server) {
    const runtime = await getLocalRuntimeMetrics();
    server.lastHealthCheckAt = new Date();
    server.lastHeartbeatAt = runtime.interfaceUp ? new Date() : server.lastHeartbeatAt;

    if (!server.enabled) {
        server.status = 'disabled';
    } else if (server.maintenanceMode) {
        server.status = 'maintenance';
    } else if (!runtime.interfaceUp || runtime.error) {
        server.status = 'degraded';
    } else if (runtime.stalePeers > 0) {
        server.status = 'degraded';
    } else {
        server.status = 'healthy';
    }

    await server.save();
    return runtime;
}

async function restartLocalWireGuard() {
    try {
        await execFileAsync('wg-quick', ['down', 'wg0']);
    } catch (error) {
        log('warn', 'wg_quick_down_failed', { error: error.message });
    }

    await execFileAsync('wg-quick', ['up', 'wg0']);
    await loadClientsFromDatabase(true);
}

async function reconcileLocalWireGuard() {
    await loadClientsFromDatabase(true);
}

module.exports = {
    LOCAL_NODE_ID,
    ensureLocalVpnServer,
    getLocalRuntimeMetrics,
    syncLocalServerHealth,
    restartLocalWireGuard,
    reconcileLocalWireGuard
};
