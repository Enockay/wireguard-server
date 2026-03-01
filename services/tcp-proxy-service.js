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
        log('info', 'proxy_connection_received', { 
            publicPort, 
            target: `${targetIp}:${targetPort}`,
            router: routerName,
            client: clientInfo,
            timestamp: new Date().toISOString()
        });

        let targetSocket = null;
        let bytesForwarded = 0;
        let bytesReceived = 0;

        try {
            targetSocket = net.createConnection(targetPort, targetIp, () => {
                log('info', 'proxy_target_connected', {
                    publicPort,
                    target: `${targetIp}:${targetPort}`,
                    router: routerName,
                    client: clientInfo
                });
                
                // Pipe data both ways
                clientSocket.pipe(targetSocket);
                targetSocket.pipe(clientSocket);
                
                // Track data flow
                clientSocket.on('data', (data) => {
                    bytesReceived += data.length;
                });
                
                targetSocket.on('data', (data) => {
                    bytesForwarded += data.length;
                });
            });

            targetSocket.on('error', (err) => {
                log('error', 'proxy_target_connection_failed', { 
                    publicPort, 
                    target: `${targetIp}:${targetPort}`,
                    router: routerName,
                    client: clientInfo,
                    error: err.message,
                    code: err.code,
                    errno: err.errno
                });
                if (clientSocket && !clientSocket.destroyed) {
                    clientSocket.destroy();
                }
            });

            clientSocket.on('error', (err) => {
                log('error', 'proxy_client_error', { 
                    publicPort, 
                    router: routerName,
                    client: clientInfo,
                    error: err.message,
                    code: err.code
                });
                if (targetSocket && !targetSocket.destroyed) {
                    targetSocket.destroy();
                }
            });

            clientSocket.on('close', () => {
                log('info', 'proxy_client_closed', {
                    publicPort,
                    router: routerName,
                    client: clientInfo,
                    bytesReceived,
                    bytesForwarded
                });
                if (targetSocket && !targetSocket.destroyed) {
                    targetSocket.destroy();
                }
            });

            targetSocket.on('close', () => {
                log('info', 'proxy_target_closed', {
                    publicPort,
                    target: `${targetIp}:${targetPort}`,
                    router: routerName,
                    client: clientInfo,
                    bytesReceived,
                    bytesForwarded
                });
                if (clientSocket && !clientSocket.destroyed) {
                    clientSocket.destroy();
                }
            });
        } catch (error) {
            log('error', 'proxy_creation_error', {
                publicPort,
                router: routerName,
                error: error.message
            });
            if (clientSocket && !clientSocket.destroyed) {
                clientSocket.destroy();
            }
        }
    });

    server.listen(publicPort, '0.0.0.0', () => {
        const address = server.address();
        log('info', 'proxy_server_listening', { 
            publicPort, 
            target: `${targetIp}:${targetPort}`,
            router: routerName,
            address: address.address,
            family: address.family,
            port: address.port
        });
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log('error', 'proxy_port_in_use', { 
                publicPort, 
                router: routerName,
                error: err.message,
                code: err.code
            });
        } else {
            log('error', 'proxy_server_error', { 
                publicPort, 
                router: routerName,
                error: err.message,
                code: err.code,
                errno: err.errno
            });
        }
    });

    // Track server state
    server.on('listening', () => {
        log('info', 'proxy_server_listening_state', {
            publicPort,
            router: routerName,
            listening: server.listening,
            address: server.address()
        });
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

    const status = {
        running: true,
        winbox: {
            listening: proxies.winbox.listening,
            address: proxies.winbox.address ? proxies.winbox.address() : null,
            connections: proxies.winbox.connections || 0
        },
        ssh: {
            listening: proxies.ssh.listening,
            address: proxies.ssh.address ? proxies.ssh.address() : null,
            connections: proxies.ssh.connections || 0
        },
        api: {
            listening: proxies.api.listening,
            address: proxies.api.address ? proxies.api.address() : null,
            connections: proxies.api.connections || 0
        }
    };

    return status;
}

/**
 * Get all active proxy ports (for monitoring)
 */
function getAllActiveProxies() {
    const result = [];
    for (const [routerId, proxies] of activeProxies.entries()) {
        try {
            result.push({
                routerId,
                winbox: {
                    listening: proxies.winbox.listening,
                    address: proxies.winbox.address ? proxies.winbox.address() : null
                },
                ssh: {
                    listening: proxies.ssh.listening,
                    address: proxies.ssh.address ? proxies.ssh.address() : null
                },
                api: {
                    listening: proxies.api.listening,
                    address: proxies.api.address ? proxies.api.address() : null
                }
            });
        } catch (error) {
            log('error', 'get_proxy_address_error', { routerId, error: error.message });
        }
    }
    return result;
}

/**
 * Test proxy connectivity by attempting to connect to target
 */
async function testProxyConnection(routerId, portType) {
    try {
        const router = await MikrotikRouter.findById(routerId)
            .populate('wireguardClientId');

        if (!router || !router.wireguardClientId) {
            throw new Error('Router or WireGuard client not found');
        }

        const vpnIp = router.wireguardClientId.ip.split('/')[0];
        const publicPort = router.ports[portType];
        const targetPort = MIKROTIK_PORTS[portType];

        return new Promise((resolve, reject) => {
            const testSocket = net.createConnection(targetPort, vpnIp, () => {
                log('info', 'proxy_test_success', {
                    routerId,
                    routerName: router.name,
                    portType,
                    publicPort,
                    target: `${vpnIp}:${targetPort}`
                });
                testSocket.destroy();
                resolve({ success: true, target: `${vpnIp}:${targetPort}` });
            });

            testSocket.on('error', (err) => {
                log('error', 'proxy_test_failed', {
                    routerId,
                    routerName: router.name,
                    portType,
                    publicPort,
                    target: `${vpnIp}:${targetPort}`,
                    error: err.message,
                    code: err.code
                });
                resolve({ 
                    success: false, 
                    target: `${vpnIp}:${targetPort}`,
                    error: err.message,
                    code: err.code
                });
            });

            testSocket.setTimeout(5000, () => {
                testSocket.destroy();
                resolve({ 
                    success: false, 
                    target: `${vpnIp}:${targetPort}`,
                    error: 'Connection timeout'
                });
            });
        });
    } catch (error) {
        log('error', 'proxy_test_error', { routerId, portType, error: error.message });
        return { success: false, error: error.message };
    }
}

module.exports = {
    startRouterProxy,
    stopRouterProxy,
    restartRouterProxy,
    initializeAllProxies,
    getProxyStatus,
    getAllActiveProxies,
    testProxyConnection,
    MIKROTIK_PORTS
};
