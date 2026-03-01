// Load environment variables from .env file FIRST (before any other imports)
require('dotenv').config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const db = require("./db");
const Client = require("./models/Client");
const {
    wgLock,
    log,
    STATS_UPDATE_INTERVAL,
    CLEANUP_INTERVAL,
    RECONCILE_INTERVAL,
    isValidWgKey,
    isValidCidr,
    runWgCommand,
    waitForWireGuard,
    validateKeepalive
} = require("./wg-core");
const { loadClientsFromDatabase } = require("./utils/route-helpers");

// Import route modules
const registerClientRoutes = require("./routes/clients");
const registerMikrotikRoutes = require("./routes/mikrotik");
const registerLegacyRoutes = require("./routes/legacy");
const registerAdminRoutes = require("./routes/admin");
const { registerAuthRoutes } = require("./routes/auth");
const { registerMikrotikRouterRoutes, updateRouterStatus } = require("./routes/mikrotik-routers");
const { processAllDueSubscriptions } = require("./services/billing-service");
const registerProfileRoutes = require("./routes/profile");
const registerBillingRoutes = require("./routes/billing");
const registerReferralRoutes = require("./routes/referrals");
const registerSupportRoutes = require("./routes/support");

// Allow running API without a WireGuard interface present (e.g. local dev).
// When disabled, we skip wg0 readiness checks and wg-dependent background jobs.
const WG_ENABLED = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());
log('info', 'wg_enabled_config', { WG_ENABLED, raw: process.env.WG_ENABLED });

const app = express();

// Enable CORS for all routes with explicit allowed origins
const allowedOrigins = [
    "https://admin.blackie-networks.com",
    "https://app.blackie-networks.com",
    "https://mikrotik.blackie-networks.com",
    "https://blackie-softwareadmin-enockays-projects.vercel.app",
    "http://localhost:5000",
    "http://localhost:5173"
];

// Configure CORS with explicit origin validation
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, etc.)
        if (!origin) {
            return callback(null, true);
        }
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    exposedHeaders: [],
    maxAge: 86400 // 24 hours
}));

app.use(bodyParser.json());

// Initialize MongoDB connection
let dbInitialized = false;

// Register all routes (pass getter function so routes can check current state)
registerAuthRoutes(app); // No auth required for signup/login
registerClientRoutes(app, () => dbInitialized);
registerMikrotikRoutes(app, () => dbInitialized);
registerLegacyRoutes(app, () => dbInitialized);
registerAdminRoutes(app, () => dbInitialized);
registerMikrotikRouterRoutes(app, () => dbInitialized); // User router management (requires auth)
registerProfileRoutes(app); // User profile management (requires auth)
registerBillingRoutes(app); // Billing and transactions (requires auth)
registerReferralRoutes(app); // Referral system (requires auth)
registerSupportRoutes(app); // Support tickets (requires auth)
(async () => {
    try {
        await db.connect();
        dbInitialized = true;
        log('info', 'db_initialized');

        if (WG_ENABLED) {
            // Phase 3.4: Wait for the WireGuard interface before loading peers
            const wgReady = await waitForWireGuard();
            if (wgReady) {
                log('info', 'wg_ready');
                await loadClientsFromDatabase(dbInitialized);
            } else {
                log('warn', 'wg_not_ready_after_retries');
            }

            // Start background jobs (stats, cleanup, reconciliation)
            startStatisticsUpdateJob();
        } else {
            log('info', 'wg_disabled', { note: 'WG_ENABLED=false: skipping wg0 checks and wg background jobs' });
        }

        // Start billing processing job (runs daily)
        startBillingJob();

        // Initialize TCP proxies for all active routers
        if (dbInitialized) {
            setTimeout(async () => {
                try {
                    const { initializeAllProxies } = require('./services/tcp-proxy-service');
                    await initializeAllProxies();
            } catch (error) {
                    log('error', 'init_proxies_on_startup_failed', { error: error.message });
            }
            }, 5000); // Wait 5 seconds for everything to settle
        }
    } catch (error) {
        log('error', 'db_init_failed', { error: error.message });
        dbInitialized = false;
    }
})();

// Phase 4.1 + 4.3: Update client statistics using batched MongoDB writes.
// Reduces N*2 DB round-trips (findOne + updateOne per peer) to just 2
// (one find, one bulkWrite) per 30-second cycle.
async function updateClientStatistics() {
    if (!dbInitialized) {
        return;
    }
    
    try {
        // Single wg dump via execFile (Phase 4.3)
        const wgDump = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
        const lines = wgDump.trim().split('\n').filter(l => l.trim());

        // Build a map of publicKey -> stats from wg dump
        const peerStats = new Map();
        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length < 7) continue;
            peerStats.set(parts[0].trim(), {
                endpoint: parts[1],
                lastHandshake: parts[3],
                transferRx: parts[4],
                transferTx: parts[5]
            });
        }

        // Get all enabled clients in one query
        const clients = await Client.find({ enabled: true });
        const ops = [];

        for (const client of clients) {
            const stats = peerStats.get(client.publicKey.trim());
            if (!stats) continue;

            const update = { updatedAt: new Date() };
            
            // Parse endpoint to get IP
            if (stats.endpoint && stats.endpoint !== '(none)' && stats.endpoint.trim() !== '') {
                update.lastConnectionIp = stats.endpoint.split(':')[0].trim();
            }
            
            // Parse handshake time (Unix timestamp in seconds) with proper validation
            if (stats.lastHandshake && stats.lastHandshake.trim() !== '' && stats.lastHandshake.trim() !== '0') {
                const handshakeSeconds = parseInt(stats.lastHandshake.trim());
                if (!isNaN(handshakeSeconds) && handshakeSeconds > 0) {
                    const date = new Date(handshakeSeconds * 1000);
                    const now = new Date();
                    const minDate = new Date('2020-01-01');
                    if (date instanceof Date && !isNaN(date.getTime()) && date >= minDate && date <= now) {
                        update.lastHandshake = date;
                        update.lastConnectionTime = date;
                    }
                }
            }

            // Parse transfer values (bytes)
            update.transferRx = parseInt(stats.transferRx && stats.transferRx.trim() !== '' ? stats.transferRx.trim() : '0') || 0;
            update.transferTx = parseInt(stats.transferTx && stats.transferTx.trim() !== '' ? stats.transferTx.trim() : '0') || 0;

            ops.push({
                updateOne: {
                    filter: { _id: client._id },
                    update: { $set: update }
                }
            });
        }

        if (ops.length > 0) {
            await Client.bulkWrite(ops, { ordered: false });
        }
    } catch (error) {
        // Silently fail - WireGuard might not be running
        if (error.message && !error.message.includes('No such device')) {
            log('error', 'stats_update_error', { error: error.message });
        }
    }
}

async function cleanupDisabledPeers() {
    if (!dbInitialized) return;
    
    try {
        const wgDump = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
        const lines = wgDump.trim().split('\n').filter(line => line.trim());
        const activePeerKeys = new Set(
            lines.map(l => l.split('\t')[0].trim()).filter(k => k)
        );
        
        const disabledClients = await Client.find({ enabled: false });
        const toRemove = disabledClients.filter(
            c => activePeerKeys.has(c.publicKey.trim())
        );
        
        if (toRemove.length > 0) {
            // Batch removal under a single lock acquisition
            await wgLock.run(async () => {
                for (const client of toRemove) {
                    // Phase 2.2: Validate key before passing to command
                    if (!isValidWgKey(client.publicKey)) {
                        log('warn', 'invalid_peer_key', { peer: client.name, action: 'skip_removal' });
                        continue;
                    }
                    try {
                        await runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']);
                        log('info', 'removed_disabled_peer', { peer: client.name });
        } catch (error) {
                        // Ignore -- peer might already be gone
                    }
                }
            });
        }
    } catch (error) {
        if (error.message && !error.message.includes('No such device')) {
            log('error', 'cleanup_disabled_error', { error: error.message });
        }
    }
}

async function reconcilePeers() {
    if (!dbInitialized) return;

    try {
        // 1. Get set of public keys currently in kernel
        const wgDump = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
        const kernelKeys = new Set();
        const lines = wgDump.trim().split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split('\t');
            // Peer lines have 8 fields; the interface line has 4 -- skip it
            if (parts.length < 7) continue;
            kernelKeys.add(parts[0].trim());
        }

        // 2. Get set of public keys that should exist (enabled in DB)
        const enabledClients = await Client.find({ enabled: true });
        const dbEnabledKeys = new Map(
            enabledClients.map(c => [c.publicKey.trim(), c])
        );

        // 3. Find missing peers: in DB (enabled) but not in kernel
        const missing = [];
        for (const [key, client] of dbEnabledKeys) {
            if (!kernelKeys.has(key)) {
                missing.push(client);
            }
        }

        // 4. Re-add missing peers via wg addconf (NOT syncconf -- see loadClientsFromDatabase)
        if (missing.length > 0) {
            log('warn', 'peers_missing', { count: missing.length, peers: missing.map(c => c.name) });

            // Build config with only the missing peers (addconf won't touch existing ones)
            let conf = '';
            for (const client of missing) {
                if (!isValidWgKey(client.publicKey) || !isValidCidr(client.ip)) {
                    continue;
                }
        const keepalive = validateKeepalive(client.persistentKeepalive);
                conf += `[Peer]\n`;
                conf += `PublicKey = ${client.publicKey}\n`;
                conf += `AllowedIPs = ${client.ip}\n`;
                conf += `PersistentKeepalive = ${keepalive}\n\n`;
            }

            const tmpFile = '/tmp/wg0-reconcile.conf';
            fs.writeFileSync(tmpFile, conf);
            await wgLock.run(() => runWgCommand(['addconf', 'wg0', tmpFile]));
            fs.unlinkSync(tmpFile);

            log('info', 'reconcile_complete', { added: missing.length, unchanged: enabledClients.length - missing.length });
        }

        // 5. Check for extra peers (in kernel but not in any DB record)
        const disabledClients = await Client.find({ enabled: false });
        const dbAllKeys = new Set([
            ...enabledClients.map(c => c.publicKey.trim()),
            ...disabledClients.map(c => c.publicKey.trim())
        ]);

        const extra = [];
        for (const key of kernelKeys) {
            if (!dbAllKeys.has(key)) {
                extra.push(key);
            }
        }

        if (extra.length > 0) {
            log('warn', 'unknown_kernel_peers', { count: extra.length });
        }
        } catch (error) {
        // Silently ignore if WireGuard interface doesn't exist yet
        if (error.message && !error.message.includes('No such device')) {
            log('error', 'reconcile_error', { error: error.message });
        }
    }
}

// Start background jobs for statistics, disabled-peer cleanup, and reconciliation
function startStatisticsUpdateJob() {
    // Run statistics update immediately, then every 30 seconds (read-only)
    updateClientStatistics();
    setInterval(updateClientStatistics, STATS_UPDATE_INTERVAL);
    log('info', 'job_started', { job: 'statistics', intervalSec: STATS_UPDATE_INTERVAL / 1000 });
    
    // Run disabled-peer cleanup every 5 minutes (Phase 1.1)
    setInterval(cleanupDisabledPeers, CLEANUP_INTERVAL);
    log('info', 'job_started', { job: 'cleanup_disabled', intervalSec: CLEANUP_INTERVAL / 1000 });

// Run peer reconciliation every 2 minutes (Phase 2.1)
    // First run after 30s to let initial load settle
    setTimeout(() => {
        reconcilePeers();
        setInterval(reconcilePeers, RECONCILE_INTERVAL);
    }, 30000);
    log('info', 'job_started', { job: 'reconciliation', intervalSec: RECONCILE_INTERVAL / 1000 });
}

// Billing processing job (runs daily)
function startBillingJob() {
    const { processAllDueSubscriptions } = require('./services/billing-service');
    
    const processBilling = async () => {
        try {
            if (!dbInitialized) return;
            log('info', 'billing_job_started');
            const results = await processAllDueSubscriptions();
            log('info', 'billing_job_completed', { processed: results.length });
            } catch (error) {
            log('error', 'billing_job_error', { error: error.message });
        }
    };

    // Run immediately, then every 24 hours
    processBilling();
    setInterval(processBilling, 24 * 60 * 60 * 1000); // 24 hours

    log('info', 'billing_job_scheduled', { interval: '24 hours' });
}

// Router status monitoring (checks every 5 minutes)
function startRouterStatusMonitoring() {
    if (!WG_ENABLED) return;

    const MikrotikRouter = require('./models/MikrotikRouter');
    const { checkRouterActive } = require('./services/mikrotik-api-service');

    const checkRouterStatus = async () => {
        try {
            if (!dbInitialized) return;

            // Get all active routers
            const routers = await MikrotikRouter.find({ status: { $in: ['pending', 'active', 'offline'] } })
                .populate('wireguardClientId');

            log('info', 'router_status_check_started', { count: routers.length });

            // Check each router by connecting to it and retrieving routerboard info
            for (const router of routers) {
                if (!router.wireguardClientId) {
                    continue;
                }

                try {
                    const vpnIp = router.wireguardClientId.ip.split('/')[0]; // Remove /32
                    
                    // Check router by accessing it via VPN IP and getting routerboard info
                    const activeCheck = await checkRouterActive(vpnIp, {
                        username: 'admin', // Default username, can be made configurable
                        password: '', // Empty password (use SSH keys in production)
                        method: 'ssh', // Try SSH first, falls back to API port check
                        timeout: 5000
                    });

                    const isActive = activeCheck.isActive;
                    const routerboardInfo = activeCheck.info;

                    // Update router status and store routerboard info
                    await updateRouterStatus(router._id, isActive, routerboardInfo);

                    if (isActive) {
                        log('info', 'router_status_check_success', {
                            routerId: router._id,
                            routerName: router.name,
                            vpnIp,
                            uptime: routerboardInfo.uptime || 'N/A'
                        });
                    } else {
                        log('warn', 'router_status_check_failed', {
                            routerId: router._id,
                            routerName: router.name,
                            vpnIp,
                            error: routerboardInfo.error || 'Unknown error'
                        });
                    }
                } catch (error) {
                    log('error', 'router_status_check_error', {
                        routerId: router._id,
                        routerName: router.name,
                        error: error.message
                    });
                    // Mark as offline if check fails
                    await updateRouterStatus(router._id, false);
                }

                // Small delay between checks to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            log('info', 'router_status_check_completed', { count: routers.length });
        } catch (error) {
            log('error', 'router_status_monitoring_error', { error: error.message });
        }
    };

    // Run every 5 minutes
    setInterval(checkRouterStatus, 5 * 60 * 1000);
    checkRouterStatus(); // Run immediately

    log('info', 'router_status_monitoring_started', { interval: '5 minutes' });
}

// Run API on TCP Port (default 5000, can be overridden via PORT env var)
const PORT = process.env.PORT || 5000;
// Bind to 0.0.0.0 to make it accessible from outside the container
// This is especially important when using network_mode: "service:wireguard"
app.listen(PORT, '0.0.0.0', () => {
    log('info', 'server_started', { port: PORT, host: '0.0.0.0' });
    
    // Start router status monitoring if WireGuard is enabled
    if (WG_ENABLED) {
        setTimeout(() => {
            startRouterStatusMonitoring();
        }, 10000); // Wait 10 seconds for DB to be ready
    }
});
