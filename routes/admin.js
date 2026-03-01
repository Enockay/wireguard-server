const Client = require("../models/Client");
const {
    wgLock,
    log,
    runWgCommand
} = require("../wg-core");
const {
    loadClientsFromDatabase,
    getTimeAgo
} = require("../utils/route-helpers");

// Register all admin/system routes
function registerAdminRoutes(app, getDbInitialized) {
    const wgEnabled = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());

    // Get admin statistics
    app.get("/api/admin/stats", async (req, res) => {
        try {
            const dbInitialized = getDbInitialized();
            if (!dbInitialized) {
                return res.status(503).json({
                    success: false,
                    message: "Database not initialized",
                    error: "WIREGUARD_ERROR"
                });
            }
            
            const [totalClients, enabledClients, disabledClients, recentClients] = await Promise.all([
                Client.countDocuments(),
                Client.countDocuments({ enabled: true }),
                Client.countDocuments({ enabled: false }),
                Client.find().sort({ createdAt: -1 }).limit(5)
            ]);
            
            // Get WireGuard status with detailed connection info
            let wgStatus = null;
            let connectedDetails = [];
            try {
                if (!wgEnabled) {
                    wgStatus = { status: "disabled" };
                    throw new Error("WG_DISABLED");
                }
                const wgShow = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
                const peers = wgShow.trim().split('\n').filter(line => line.trim());
                
                // Parse peer details and match with clients
                for (const peerLine of peers) {
                    const parts = peerLine.split('\t');
                    if (parts.length >= 7) {
                        const publicKey = parts[0].trim();
                        const endpoint = parts[1];
                        const lastHandshake = parts[3];
                        
                        // Find matching client (only enabled ones)
                        const client = await Client.findOne({ publicKey: publicKey.trim(), enabled: true });
                        if (client) {
                            let handshakeTime = null;
                            if (lastHandshake && lastHandshake.trim() !== '' && lastHandshake.trim() !== '0') {
                                const handshakeSeconds = parseInt(lastHandshake.trim());
                                if (!isNaN(handshakeSeconds) && handshakeSeconds > 0) {
                                    const date = new Date(handshakeSeconds * 1000);
                                    const now = new Date();
                                    const minDate = new Date('2020-01-01');
                                    if (date instanceof Date && !isNaN(date.getTime()) && date >= minDate && date <= now) {
                                        handshakeTime = date;
                                    }
                                }
                            }
                            
                            const timeAgo = handshakeTime 
                                ? getTimeAgo(handshakeTime)
                                : 'Never';
                            
                            connectedDetails.push(
                                `${client.name} - ${client.ip} - Last seen: ${timeAgo}`
                            );
                        }
                    }
                }
                
                wgStatus = {
                    connected: peers.length,
                    details: connectedDetails.length > 0 ? connectedDetails : peers
                };
            } catch (error) {
                if (!wgStatus) {
                    wgStatus = {
                        connected: 0,
                        error: wgEnabled ? "WireGuard interface not available" : "WireGuard disabled"
                    };
                }
            }
            
            res.json({
                success: true,
                stats: {
                    clients: {
                        total: totalClients,
                        enabled: enabledClients,
                        disabled: disabledClients
                    },
                    wireguard: wgStatus,
                    recent: recentClients.map(c => {
                        const safe = c.toSafeJSON();
                        return {
                            name: safe.name,
                            lastHandshake: c.lastHandshake ? c.lastHandshake.toISOString() : null,
                            transferRx: c.transferRx || 0,
                            transferTx: c.transferTx || 0
                        };
                    })
                }
            });
        } catch (error) {
            log('error', 'admin_stats_error', { error: error.message });
            res.status(500).json({
                success: false,
                message: "Failed to get statistics",
                error: "WIREGUARD_ERROR",
                details: error.message
            });
        }
    });

    // Health check endpoint
    app.get("/", (req, res) => {
        res.json({ 
            status: "running",
            service: "WireGuard VPN Management API",
            database: getDbInitialized() ? "connected" : "not connected",
            version: "2.0.0",
            endpoints: {
                "GET /api/clients": "List all clients (with filtering, pagination)",
                "GET /api/clients/:name": "Get client details",
                "GET /api/clients/:name/config": "Get WireGuard config file",
                "GET /api/clients/:name/mikrotik": "Get MikroTik script",
                "GET /api/clients/:name/autoconfig": "Get MikroTik auto-config script",
                "POST /api/clients/:name/ping": "Ping remote server from client",
                "POST /api/clients": "Create new client",
                "PUT /api/clients/:name": "Update client",
                "DELETE /api/clients/:name": "Delete client",
                "POST /api/clients/:name/regenerate": "Regenerate client keys",
                "POST /api/clients/:name/enable": "Enable client",
                "POST /api/clients/:name/disable": "Disable client",
                "POST /api/clients/bulk-delete": "Bulk delete clients",
                "GET /api/admin/stats": "Get statistics with real-time connection details",
                "POST /generate-client": "Generate new client (legacy)",
                "POST /generate-mikrotik": "Generate MikroTik script (legacy)",
                "GET /mt/:name": "Get MikroTik script (short URL)",
                "GET /list-peers": "List active WireGuard connections"
            }
        });
    });

    // Phase 5.2: Enhanced health check with per-peer handshake age.
    // A peer whose last handshake was >3 minutes ago is stale (WireGuard rekeys every 2 min).
    // This lets external monitors (Coolify health check, uptime robot, etc.) detect
    // handshake problems before they escalate.
    app.get("/api/health", async (req, res) => {
        try {
            const health = {
                status: "healthy",
                timestamp: new Date().toISOString(),
                service: "WireGuard VPN Management API",
                database: getDbInitialized() ? "connected" : "disconnected",
                wireguard: null,
                stalePeers: []
            };
            
            // Check WireGuard status and peer handshake health
            try {
                if (!wgEnabled) {
                    health.wireguard = "disabled";
                    throw new Error("WG_DISABLED");
                }
                const dump = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
                health.wireguard = "running";
                
                const now = Date.now() / 1000;
                for (const line of dump.trim().split('\n')) {
                    const parts = line.split('\t');
                    if (parts.length < 7) continue;
                    const handshake = parseInt(parts[3]);
                    if (handshake > 0 && (now - handshake) > 180) {
                        health.stalePeers.push({
                            publicKey: parts[0].substring(0, 8) + '...',
                            lastHandshakeSec: Math.floor(now - handshake)
                        });
                    }
                }
            } catch (error) {
                if (health.wireguard !== "disabled") {
                    health.wireguard = "not running";
                    health.wireguardError = error.message;
                }
            }
            
            const statusCode = wgEnabled
                ? ((getDbInitialized() && health.wireguard === "running") ? 200 : 503)
                : (getDbInitialized() ? 200 : 503);
            res.status(statusCode).json(health);
        } catch (error) {
            res.status(503).json({
                status: "unhealthy",
                error: error.message
            });
        }
    });

    // Manual reload from database
    app.post("/reload", async (req, res) => {
        try {
            await loadClientsFromDatabase(getDbInitialized());
            res.json({
                success: true,
                message: "Clients reloaded from database"
            });
        } catch (error) {
            log('error', 'reload_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to reload clients",
                details: error.message
            });
        }
    });

    // Get TCP proxy status (admin)
    app.get("/api/admin/proxy/status", async (req, res) => {
        try {
            const { getAllActiveProxies } = require('../services/tcp-proxy-service');
            const proxies = getAllActiveProxies();
            
            res.json({
                success: true,
                proxies: proxies,
                count: proxies.length
            });
        } catch (error) {
            log('error', 'get_proxy_status_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to get proxy status",
                details: error.message
            });
        }
    });
}

module.exports = registerAdminRoutes;
