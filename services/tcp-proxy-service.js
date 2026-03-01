const net = require('net');
const MikrotikRouter = require('../models/MikrotikRouter');
const { log } = require('../wg-core');

// Store active proxy servers
const activeProxies = new Map();

// Default MikroTik ports
const MIKROTIK_PORTS = {
    winbox: 8291,
    ssh: 22,
    api: 8728
};

/**
 * Create TCP proxy server for a specific port
 */
function createProxyServer(publicPort, targetPort, targetIp, routerName) {
    const server = net.createServer((clientSocket) => {
        const clientInfo = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
        log('info', 'proxy_connection', { 
            publicPort, 
            target: `${targetIp}:${targetPort}`,
            router: routerName,
            client: clientInfo
        });

        const targetSocket = net.createConnection(targetPort, targetIp, () => {
            log('info', 'proxy_connected', {
                publicPort,
                target: `${targetIp}:${targetPort}`,
                router: routerName
            });
            clientSocket.pipe(targetSocket);
            targetSocket.pipe(clientSocket);
        });

        targetSocket.on('error', (err) => {
            log('error', 'proxy_target_error', { 
                publicPort, 
                target: `${targetIp}:${targetPort}`,
                router: routerName,
                error: err.message 
            });
            clientSocket.destroy();
        });

        clientSocket.on('error', (err) => {
            log('error', 'proxy_client_error', { 
                publicPort, 
                router: routerName,
                error: err.message 
            });
            targetSocket.destroy();
        });

        clientSocket.on('close', () => {
            targetSocket.destroy();
        });

        targetSocket.on('close', () => {
            clientSocket.destroy();
        });
    });

    server.listen(publicPort, '0.0.0.0', () => {
        log('info', 'proxy_server_started', { 
            publicPort, 
            target: `${targetIp}:${targetPort}`,
            router: routerName
        });
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log('warn', 'proxy_port_in_use', { 
                publicPort, 
                router: routerName,
                error: err.message 
            });
        } else {
            log('error', 'proxy_server_error', { 
                publicPort, 
                router: routerName,
                error: err.message 
            });
        }
    });

    return server;
}

/**
 * Start proxy for a MikroTik router
 */
async function startRouterProxy(routerId) {
    try {
        const router = await MikrotikRouter.findById(routerId)
            .populate('wireguardClientId');

        if (!router || !router.wireguardClientId) {
            throw new Error('Router or WireGuard client not found');
        }

        const vpnIp = router.wireguardClientId.ip.split('/')[0]; // Remove /32

        // Check if proxies already exist
        if (activeProxies.has(routerId.toString())) {
            log('warn', 'proxy_already_running', { routerId, routerName: router.name });
            return activeProxies.get(routerId.toString());
        }

        const proxies = {};

        // Start Winbox proxy
        proxies.winbox = createProxyServer(
            router.ports.winbox,
            MIKROTIK_PORTS.winbox,
            vpnIp,
            router.name
        );

        // Start SSH proxy
        proxies.ssh = createProxyServer(
            router.ports.ssh,
            MIKROTIK_PORTS.ssh,
            vpnIp,
            router.name
        );

        // Start API proxy
        proxies.api = createProxyServer(
            router.ports.api,
            MIKROTIK_PORTS.api,
            vpnIp,
            router.name
        );

        activeProxies.set(routerId.toString(), proxies);

        log('info', 'router_proxy_started', { 
            routerId, 
            routerName: router.name,
            ports: router.ports,
            vpnIp
        });

        return proxies;
    } catch (error) {
        log('error', 'start_proxy_error', { routerId, error: error.message });
        throw error;
    }
}

/**
 * Stop proxy for a router
 */
function stopRouterProxy(routerId) {
    const proxies = activeProxies.get(routerId.toString());
    if (proxies) {
        Object.values(proxies).forEach(server => {
            try {
                server.close();
            } catch (error) {
                log('error', 'proxy_close_error', { routerId, error: error.message });
            }
        });
        activeProxies.delete(routerId.toString());
        log('info', 'router_proxy_stopped', { routerId });
    }
}

/**
 * Restart proxy for a router (useful when router IP changes)
 */
async function restartRouterProxy(routerId) {
    stopRouterProxy(routerId);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    return startRouterProxy(routerId);
}

/**
 * Initialize all active router proxies on startup
 */
async function initializeAllProxies() {
    try {
        const routers = await MikrotikRouter.find({ 
            status: { $in: ['pending', 'active'] } 
        })
            .populate('wireguardClientId');

        let started = 0;
        let failed = 0;

        for (const router of routers) {
            if (router.wireguardClientId) {
                try {
                    await startRouterProxy(router._id);
                    started++;
                } catch (error) {
                    log('error', 'init_proxy_failed', { 
                        routerId: router._id, 
                        routerName: router.name,
                        error: error.message 
                    });
                    failed++;
                }
            }
        }

        log('info', 'all_proxies_initialized', { 
            total: routers.length,
            started,
            failed
        });

        return { started, failed, total: routers.length };
    } catch (error) {
        log('error', 'init_proxies_error', { error: error.message });
        throw error;
    }
}

/**
 * Get proxy status for a router
 */
function getProxyStatus(routerId) {
    const proxies = activeProxies.get(routerId.toString());
    if (!proxies) {
        return { running: false };
    }

    return {
        running: true,
        winbox: proxies.winbox.listening,
        ssh: proxies.ssh.listening,
        api: proxies.api.listening
    };
}

/**
 * Get all active proxy ports (for monitoring)
 */
function getAllActiveProxies() {
    const result = [];
    for (const [routerId, proxies] of activeProxies.entries()) {
        result.push({
            routerId,
            winbox: proxies.winbox.address(),
            ssh: proxies.ssh.address(),
            api: proxies.api.address()
        });
    }
    return result;
}

module.exports = {
    startRouterProxy,
    stopRouterProxy,
    restartRouterProxy,
    initializeAllProxies,
    getProxyStatus,
    getAllActiveProxies,
    MIKROTIK_PORTS
};
