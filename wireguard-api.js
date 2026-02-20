const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const db = require("./db");
const Client = require("./models/Client");

// Phase 1.3: Async mutex to serialize all wg set/show operations.
// Prevents the stats job, API endpoints, and reload from stepping on each other.
class WgMutex {
    constructor() {
        this._queue = Promise.resolve();
    }
    run(fn) {
        const task = this._queue.then(() => fn());
        // Catch so the queue doesn't break on rejection
        this._queue = task.catch(() => {});
        return task;
    }
}

const wgLock = new WgMutex();

// Phase 5.1: Structured logging.
// Wraps console output in JSON for machine-parsable container logs.
// No external dependencies -- just a thin wrapper around console.
function log(level, msg, data = {}) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        ...data
    };
    console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

const app = express();

// Enable CORS for all routes with explicit allowed origins
const allowedOrigins = [
    "https://admin.blackie-networks.com",
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

const KEEPALIVE_TIME = 25; // Keepalive interval (in seconds)
const STARTING_CLIENT_IP = 6; // Start assigning IPs from 10.0.0.6 (1=server, 2-5=preconfigured)
const STATS_UPDATE_INTERVAL = 30000; // Update statistics every 30 seconds

// Helper function to validate and normalize persistent keepalive value
function validateKeepalive(value) {
    const keepalive = parseInt(value);
    if (isNaN(keepalive) || keepalive < 0 || keepalive > 65535) {
        return KEEPALIVE_TIME;
    }
    return keepalive;
}

// Helper function to strip CIDR notation from IP address
function stripCidr(ip) {
    if (typeof ip === 'string' && ip.includes('/')) {
        return ip.split('/')[0];
    }
    return ip;
}

// Phase 2.2: Input validation to prevent shell injection.
// Every value interpolated into a wg command must pass these checks first.
function isValidWgKey(key) {
    // WireGuard keys are exactly 44 chars of base64 (43 chars + trailing '=')
    return typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key);
}

function isValidCidr(ip) {
    return typeof ip === 'string' && /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(ip);
}

// Phase 3.4: Wait for WireGuard interface with exponential backoff.
// If wg-quick up hasn't finished yet, loadClientsFromDatabase() would fail
// silently and peers would never be loaded.
async function waitForWireGuard(maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await runWgCommand(['show', 'wg0']);
            return true;
        } catch (e) {
            const delay = Math.min(2000 * (i + 1), 15000);
            log('info', 'wg_wait_retry', { attempt: i + 1, maxRetries, delayMs: delay });
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return false;
}

// Initialize MongoDB connection
let dbInitialized = false;
(async () => {
    try {
        await db.connect();
        dbInitialized = true;
        log('info', 'db_initialized');

        // Phase 3.4: Wait for the WireGuard interface before loading peers
        const wgReady = await waitForWireGuard();
        if (wgReady) {
            log('info', 'wg_ready');
            await loadClientsFromDatabase();
        } else {
            log('warn', 'wg_not_ready_after_retries');
        }

        // Start background jobs (stats, cleanup, reconciliation)
        startStatisticsUpdateJob();
    } catch (error) {
        log('error', 'db_init_failed', { error: error.message });
        dbInitialized = false;
    }
})();

// Function to execute shell commands safely.
// Phase 2.3: Rejects with proper Error objects (not raw strings) and adds
// a 10s timeout so a hung wg process doesn't block the mutex queue forever.
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(stderr.trim() || error.message);
                err.code = error.code;
                log('error', 'cmd_exec_error', { error: err.message });
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

// Phase 4.3: Direct binary execution for wg commands.
// execFile() runs the binary directly without spawning a shell -- faster,
// no shell injection risk, and lower memory usage than exec().
function runWgCommand(args) {
    return new Promise((resolve, reject) => {
        execFile('wg', args, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(stderr.trim() || error.message);
                err.code = error.code;
                log('error', 'wg_cmd_error', { subcommand: args[0], error: err.message });
                return reject(err);
            }
            resolve(stdout);
        });
    });
}

// Generate WireGuard keys (Phase 4.3: uses execFile, no shell needed)
async function generateKeys() {
    const privateKey = (await runWgCommand(['genkey'])).trim();
    // Pipe private key via stdin to wg pubkey (avoids shell echo pipe)
    const publicKey = await new Promise((resolve, reject) => {
        const proc = execFile('wg', ['pubkey'], { timeout: 5000 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr.trim() || err.message));
                    return;
                }
                resolve(stdout.trim());
            }
        );
        proc.stdin.write(privateKey);
        proc.stdin.end();
    });
    // Phase 2.2: Validate generated keys to catch corruption
    if (!isValidWgKey(privateKey) || !isValidWgKey(publicKey)) {
        throw new Error('Key generation produced invalid keys');
    }
    return { privateKey, publicKey };
}

// Load clients from database and apply to WireGuard using wg syncconf (Phase 1.4).
// syncconf only touches peers that differ from the running config -- existing
// active peers keep their handshake state and sessions.
async function loadClientsFromDatabase() {
    if (!dbInitialized) {
        log('warn', 'db_not_initialized', { action: 'skip_client_load' });
        return;
    }
    
    try {
        const clients = await Client.find({ enabled: true });
        log('info', 'syncconf_start', { clientCount: clients.length });
        
        // Build wg config with only [Peer] sections (no [Interface])
        // Phase 2.2: Skip clients with invalid keys/IPs (defense-in-depth)
        let conf = '';
        let skipped = 0;
        for (const client of clients) {
            if (!isValidWgKey(client.publicKey) || !isValidCidr(client.ip)) {
                log('warn', 'invalid_client_data', { client: client.name, action: 'skip_sync' });
                skipped++;
                continue;
            }
            const keepalive = validateKeepalive(client.persistentKeepalive);
            conf += `[Peer]\n`;
            conf += `PublicKey = ${client.publicKey}\n`;
            conf += `AllowedIPs = ${client.ip}\n`;
            conf += `PersistentKeepalive = ${keepalive}\n\n`;
        }
        if (skipped > 0) {
            log('warn', 'sync_skipped_clients', { skipped });
        }
        
        const tmpFile = '/tmp/wg0-peers.conf';
        fs.writeFileSync(tmpFile, conf);
        await wgLock.run(() => runWgCommand(['syncconf', 'wg0', tmpFile]));
        fs.unlinkSync(tmpFile);
        
        log('info', 'syncconf_complete', { synced: clients.length - skipped, total: clients.length });
    } catch (error) {
        log('error', 'load_clients_failed', { error: error.message });
    }
}

// Get all currently used IPs from WireGuard
async function getUsedIPs() {
    try {
        const wgShow = await wgLock.run(() => runWgCommand(['show', 'wg0', 'dump']));
        const ips = [];
        wgShow.split('\n').forEach(line => {
            const parts = line.split('\t');
            if (parts.length > 3 && parts[3]) {
                const allowedIPs = parts[3].split(',');
                allowedIPs.forEach(ip => {
                    if (ip.includes('/')) {
                        ips.push(ip.trim());
                    }
                });
            }
        });
        return ips;
    } catch (error) {
        return ["10.0.0.1/32", "10.0.0.2/32", "10.0.0.3/32", "10.0.0.4/32", "10.0.0.5/32"]; // Return preconfigured
    }
}

// Find next available IP from database
async function getNextAvailableIP() {
    if (!dbInitialized) {
        // Fallback to old method if database not ready
        const usedIPs = await getUsedIPs();
        for (let i = STARTING_CLIENT_IP; i < 255; i++) {
            const candidateIP = `10.0.0.${i}/32`;
            if (!usedIPs.includes(candidateIP)) {
                return candidateIP;
            }
        }
        throw new Error("No available IP addresses in the VPN network");
    }
    
    try {
        // Get used IPs from database
        const clients = await Client.find({}, 'ip');
        const usedIPs = clients.map(c => c.ip);
        
        for (let i = STARTING_CLIENT_IP; i < 255; i++) {
            const candidateIP = `10.0.0.${i}/32`;
            if (!usedIPs.includes(candidateIP)) {
                return candidateIP;
            }
        }
        
        throw new Error("No available IP addresses in the VPN network");
    } catch (error) {
        log('error', 'next_ip_failed', { error: error.message || String(error) });
        throw error;
    }
}

// Phase 4.2: Cache server public key -- it never changes during the
// container's lifetime, so there's no need to shell out on every request.
let cachedServerPublicKey = null;

async function getServerPublicKey() {
    if (cachedServerPublicKey) return cachedServerPublicKey;
    try {
        const key = (await wgLock.run(() => runWgCommand(['show', 'wg0', 'public-key']))).trim();
        if (isValidWgKey(key)) {
            cachedServerPublicKey = key;
            return cachedServerPublicKey;
        }
        // wg returned a non-key value like "(none)" -- don't cache it
        log('warn', 'server_pubkey_invalid', { raw: key });
        return "REPLACE_WITH_SERVER_PUBLIC_KEY";
    } catch (error) {
        // If wireguard is not running yet, return placeholder (don't cache it)
        return "REPLACE_WITH_SERVER_PUBLIC_KEY";
    }
}

// Get server endpoint (IP or domain)
function getServerEndpoint() {
    return process.env.SERVER_ENDPOINT || "YOUR_SERVER_IP:51820";
}

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

// Phase 1.1: Separate disabled-peer cleanup (safety net only).
// Disabled peers are already removed immediately by disable/delete endpoints.
// This catches any that slip through, on a much longer interval to avoid
// contending with active handshakes.
const CLEANUP_INTERVAL = 300000; // 5 minutes

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

// Phase 2.1: Periodic reconciliation loop.
// Detects and re-adds peers that went missing from the kernel (e.g. interface
// restarts where the /reload curl missed, kernel OOM, or any other drift
// between DB state and kernel state).
const RECONCILE_INTERVAL = 120000; // 2 minutes

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

        // 4. Re-add missing peers via wg syncconf
        if (missing.length > 0) {
            log('warn', 'peers_missing', { count: missing.length, peers: missing.map(c => c.name) });

            // Build peers config for syncconf (include ALL enabled peers so
            // syncconf doesn't remove existing active ones)
            let conf = '';
            for (const client of enabledClients) {
                // Phase 2.2: Skip clients with invalid data
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
            await wgLock.run(() => runWgCommand(['syncconf', 'wg0', tmpFile]));
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

// Generate a new client configuration
app.post("/generate-client", async (req, res) => {
    try {
        const { name, notes } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                error: "Name is required. Please provide a name for the client."
            });
        }
        
        const clientName = name.toLowerCase().trim();
        log('info', 'generate_client_start', { client: clientName });
        
        // Generate client keys
        const { privateKey, publicKey } = await generateKeys();
        log('info', 'keys_generated', { client: clientName });
        
        // Get next available IP
        const allowedIPs = await getNextAvailableIP();
        log('info', 'ip_assigned', { client: clientName, ip: allowedIPs });
        
        // Save to MongoDB
        const client = new Client({
            name: clientName,
            ip: allowedIPs,
            publicKey: publicKey,
            privateKey: privateKey,
            enabled: true,
            notes: notes || ''
        });
        
        await client.save();
        log('info', 'client_saved', { client: clientName });
        
        // Add peer to WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allowedIPs, 'persistent-keepalive', String(KEEPALIVE_TIME)]));
            log('info', 'peer_added', { client: clientName });
        } catch (error) {
            log('warn', 'peer_add_failed', { client: clientName, note: 'saved to database' });
        }
        
        // Get server's public key (Phase 4.2: cached after first call)
        const serverPublicKey = (await getServerPublicKey()).trim();
        
        // Get server endpoint
        const serverEndpoint = getServerEndpoint();
        
        // Generate complete client configuration
        const clientConfig = `[Interface]
PrivateKey = ${privateKey}
Address = ${allowedIPs}

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverEndpoint}
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = ${KEEPALIVE_TIME}`;
        
        log('info', 'config_generated', { client: clientName });
        
        // Set content type for WireGuard config file
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${clientName}.conf"`);
        
        // Send the config file directly
        res.send(clientConfig);
        
    } catch (error) {
        log('error', 'generate_client_error', { error: error.message });
        
        // Handle duplicate name error
        if (error.code === 11000) {
            return res.status(409).json({ 
                success: false,
                error: "Client with this name already exists",
                field: Object.keys(error.keyPattern)[0]
            });
        }
        
        res.status(500).json({ 
            success: false,
            error: "Failed to generate client", 
            details: error.message 
        });
    }
});

// Generate a MikroTik RouterOS script that auto-configures WireGuard and tests connectivity
app.post("/generate-mikrotik", async (req, res) => {
    try {
        const { name, notes, interfaceName, allowedSubnet } = req.body || {};

        if (!name) {
            return res.status(400).json({
                success: false,
                error: "Name is required. Please provide a name for the MikroTik client."
            });
        }

        const clientName = name.toLowerCase().trim();

        // 1) Generate client keys
        const { privateKey, publicKey } = await generateKeys();

        // 2) Allocate IP (stored as /32)
        const allocatedIpWithCidr = await getNextAvailableIP(); // e.g. 10.0.0.7/32
        const allocatedIp = allocatedIpWithCidr.split("/")[0];

        // 3) Persist to DB
        const client = new Client({
            name: clientName,
            ip: allocatedIpWithCidr,
            publicKey,
            privateKey,
            enabled: true,
            notes: notes || ''
        });
        try {
            await client.save();
        } catch (err) {
            if (err && err.code === 11000) {
                return res.status(409).json({
                    success: false,
                    error: "Client with this name already exists",
                    field: Object.keys(err.keyPattern || { name: 'name' })[0]
                });
            }
            throw err;
        }

        // 4) Add to running WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allocatedIpWithCidr, 'persistent-keepalive', String(KEEPALIVE_TIME)]));
        } catch (error) {
            // Proceed even if wg0 is not yet up; DB has the record
            log('warn', 'peer_add_failed', { client: clientName, error: error?.message || String(error) });
        }

        // 5) Build MikroTik script
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = getServerEndpoint(); // expected format: host:port
        const iface = (interfaceName || `wireguard-${clientName}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const allowed = allowedSubnet || "10.0.0.0/24";

        // RouterOS script (safe to paste as one-shot)
        // Notes:
        // - Adds/sets interface
        // - Assigns /32 address
        // - Adds peer with endpoint/keepalive
        // - Ensures route to allowed subnet via WG interface
        // - Tests ping to server WG IP and prints success/failure
        const serverEndpointParts = serverEndpoint.split(':');
        const serverHost = serverEndpointParts[0];
        const serverPort = serverEndpointParts[1] || '51820';
        
        const mikrotikScript = `# Auto-generated by WireGuard API for client: ${clientName}\r\n` +
`# Creates WG interface, sets keys/IP, peer, route, then tests connectivity\r\n` +
`:local IFACE "${iface}"\r\n` +
`:local CLIENT_IP "${allocatedIpWithCidr}"\r\n` +
`:local SERVER_PUBKEY "${serverPublicKey}"\r\n` +
`:local SERVER_HOST "${serverHost}"\r\n` +
`:local SERVER_PORT "${serverPort}"\r\n` +
`:local ALLOWED_SUBNET "${allowed}"\r\n` +
`:local KEEPALIVE 25\r\n` +
`:local SERVER_WG_IP "10.0.0.1"\r\n` +
`` +
`# 1) Create interface if missing\r\n` +
`:if ([/interface wireguard print count-only where name=$IFACE] = 0) do={\r\n` +
`  /interface wireguard add name=$IFACE;\r\n` +
`  :put "Created WireGuard interface: $IFACE";\r\n` +
`} else={\r\n` +
`  :put "WireGuard interface $IFACE already exists";\r\n` +
`}\r\n` +
`# 2) Set private key\r\n` +
`/interface wireguard set [find where name=$IFACE] private-key=\"${privateKey}\";\r\n` +
`:put "Set private key for $IFACE";\r\n` +
`# 3) Assign tunnel address (only if not already assigned)\r\n` +
`:if ([/ip address print count-only where address=$CLIENT_IP] = 0) do={\r\n` +
`  /ip address add address=$CLIENT_IP interface=$IFACE disabled=no;\r\n` +
`  :put "Assigned IP address $CLIENT_IP to $IFACE";\r\n` +
`} else={\r\n` +
`  :put "IP address $CLIENT_IP already assigned";\r\n` +
`}\r\n` +
`# 4) Add or update peer (server)\r\n` +
`:local PEER_ID [/interface wireguard peers find where interface=$IFACE public-key=$SERVER_PUBKEY];\r\n` +
`:if ([:len $PEER_ID] = 0) do={\r\n` +
`  /interface wireguard peers add interface=$IFACE public-key=$SERVER_PUBKEY endpoint-address=$SERVER_HOST endpoint-port=$SERVER_PORT allowed-address=$ALLOWED_SUBNET persistent-keepalive=$KEEPALIVE;\r\n` +
`  :put "Added peer (server) to $IFACE";\r\n` +
`} else={\r\n` +
`  /interface wireguard peers set $PEER_ID endpoint-address=$SERVER_HOST endpoint-port=$SERVER_PORT allowed-address=$ALLOWED_SUBNET persistent-keepalive=$KEEPALIVE;\r\n` +
`  :put "Updated peer (server) on $IFACE";\r\n` +
`}\r\n` +
`# 5) Ensure route to allowed subnet via WG (only if not exists)\r\n` +
`:if ([/ip route print count-only where dst-address=$ALLOWED_SUBNET gateway=$IFACE] = 0) do={\r\n` +
`  /ip route add dst-address=$ALLOWED_SUBNET gateway=$IFACE disabled=no;\r\n` +
`  :put "Added route to $ALLOWED_SUBNET via $IFACE";\r\n` +
`} else={\r\n` +
`  :put "Route to $ALLOWED_SUBNET via $IFACE already exists";\r\n` +
`}\r\n` +
`# 6) Enable interface if disabled\r\n` +
`/interface wireguard enable [find where name=$IFACE];\r\n` +
`:put "Enabled interface $IFACE";\r\n` +
`# 7) Test connectivity to server WG IP\r\n` +
`:delay 2;\r\n` +
`:local success 0;\r\n` +
`:do {\r\n` +
`  /ping $SERVER_WG_IP count=3;\r\n` +
`  :set success 1;\r\n` +
`} on-error={ :set success 0; };\r\n` +
`# 8) Report\r\n` +
`:if ($success = 1) do={ :put \"✅ WG setup OK for ${clientName}. Ping to $SERVER_WG_IP succeeded.\" } else={ :put \"⚠️ WG setup completed but ping to $SERVER_WG_IP failed. Check firewall/connectivity.\" };\r\n`;

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${clientName}.rsc"`);
        return res.send(mikrotikScript);
    } catch (error) {
        log('error', 'generate_mikrotik_error', { error: error.message });
        return res.status(500).json({
            success: false,
            error: "Failed to generate MikroTik configuration script",
            details: error.message
        });
    }
});

// Ensure a client exists (create if missing) and return its record
async function ensureClientRecord({ name, notes, interfaceName }) {
    const clientName = name.toLowerCase().trim();
    let client = await Client.findOne({ name: clientName });
    if (client) {
        // Backfill optional fields
        const updates = {};
        if (interfaceName && client.interfaceName !== interfaceName) updates.interfaceName = interfaceName;
        if (notes && client.notes !== notes) updates.notes = notes;
        if (Object.keys(updates).length) {
            client = await Client.findOneAndUpdate({ _id: client._id }, updates, { new: true });
        }
        return client;
    }

    const { privateKey, publicKey } = await generateKeys();
    const allocatedIpWithCidr = await getNextAvailableIP();
    const record = new Client({
        name: clientName,
        ip: allocatedIpWithCidr,
        publicKey,
        privateKey,
        enabled: true,
        notes: notes || '',
        interfaceName: interfaceName || `wireguard-${clientName}`,
        endpoint: getServerEndpoint(),
        allowedIPs: "0.0.0.0/0",
        persistentKeepalive: KEEPALIVE_TIME
    });
    await record.save();
    try {
        await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allocatedIpWithCidr, 'persistent-keepalive', String(KEEPALIVE_TIME)]));
    } catch (e) {
        log('warn', 'peer_add_failed', { context: 'ensureClientRecord', error: e?.message || String(e) });
    }
    return record;
}

// Compact MikroTik script via short URL: GET /mt/:name
// - Finds or creates client, then returns a minified RouterOS script
// - Script auto-picks an available listen-port starting at 51810
app.get("/mt/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { notes, iface, subnet } = req.query;

        if (!name) {
            return res.status(400).json({ success: false, error: "Missing name" });
        }

        const client = await ensureClientRecord({ name, notes, interfaceName: iface });
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = client.endpoint || getServerEndpoint();

        const ifaceName = (client.interfaceName || `wireguard-${client.name}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const allowed = (subnet || "10.0.0.0/24").toString();
        const addr = client.ip; // /32
        const pKey = client.privateKey;

        // Minified RouterOS script (no comments) - improved with interface enable
        const serverEndpointParts = serverEndpoint.split(':');
        const serverHost = serverEndpointParts[0];
        const serverPort = serverEndpointParts[1] || '51820';
        const s = `:local IFACE "${ifaceName}";:local PRIV "${pKey}";:local IP "${addr}";:local SPK "${serverPublicKey}";:local HOST "${serverHost}";:local PORT "${serverPort}";:local ALLOW "${allowed}";:local LP 51810;:for i from=0 to=32 do={:local T ($LP+$i);:if ([/interface wireguard print count-only where listen-port=$T]=0) do={:set LP $T;:set i 33}};:if ([/interface wireguard print count-only where name=$IFACE]=0) do={/interface wireguard add name=$IFACE};/interface wireguard set [find where name=$IFACE] private-key=$PRIV listen-port=$LP;/interface wireguard enable [find where name=$IFACE];:if ([/ip address print count-only where address=$IP]=0) do={/ip address add address=$IP interface=$IFACE disabled=no};:local PID [/interface wireguard peers find where interface=$IFACE public-key=$SPK];:if ([:len $PID]=0) do={/interface wireguard peers add interface=$IFACE public-key=$SPK endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=25} else={/interface wireguard peers set $PID endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=25};:if ([/ip route print count-only where dst-address=$ALLOW gateway=$IFACE]=0) do={/ip route add dst-address=$ALLOW gateway=$IFACE disabled=no};:delay 2;:local ok 0;:do {/ping 10.0.0.1 count=3;:set ok 1} on-error={:set ok 0};:if ($ok=1) do={:put "OK ${name} $IFACE $IP $LP"} else={:put "FAIL ${name}"}`;

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(s);
    } catch (error) {
        log('error', 'mt_shorturl_error', { error: error.message });
        return res.status(500).json({ success: false, error: error.message });
    }
});

// MikroTik Auto-Configure (Direct URL)
app.get("/:name/configure", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).send(`Client "${name}" not found`);
        }
        
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = client.endpoint || getServerEndpoint();
        const serverEndpointParts = serverEndpoint.split(':');
        const serverHost = serverEndpointParts[0];
        const serverPort = serverEndpointParts[1] || '51820';
        
        const ifaceName = (client.interfaceName || `wireguard-${client.name}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const allowed = client.allowedIPs || "10.0.0.0/24";
        const keepalive = validateKeepalive(client.persistentKeepalive);
        
        // Generate minified MikroTik script (single line, no comments) - same format as working script
        // This format works when fetched via /tool/fetch and imported
        const autoconfigScript = `:local IFACE "${ifaceName}";:local PRIV "${client.privateKey}";:local IP "${client.ip}";:local SPK "${serverPublicKey}";:local HOST "${serverHost}";:local PORT "${serverPort}";:local ALLOW "${allowed}";:local LP 51810;:for i from=0 to=32 do={:local T ($LP+$i);:if ([/interface wireguard print count-only where listen-port=$T]=0) do={:set LP $T;:set i 33}};:if ([/interface wireguard print count-only where name=$IFACE]=0) do={/interface wireguard add name=$IFACE};/interface wireguard set [find where name=$IFACE] private-key=$PRIV listen-port=$LP;/interface wireguard enable [find where name=$IFACE];:if ([/ip address print count-only where address=$IP]=0) do={/ip address add address=$IP interface=$IFACE disabled=no};:local PID [/interface wireguard peers find where interface=$IFACE public-key=$SPK];:if ([:len $PID]=0) do={/interface wireguard peers add interface=$IFACE public-key=$SPK endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}} else={/interface wireguard peers set $PID endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}};:if ([/ip route print count-only where dst-address=$ALLOW gateway=$IFACE]=0) do={/ip route add dst-address=$ALLOW gateway=$IFACE disabled=no};:delay 2;:local ok 0;:do {/ping 10.0.0.1 count=3;:set ok 1} on-error={:set ok 0};:if ($ok=1) do={:put "OK ${client.name} $IFACE $IP $LP"} else={:put "FAIL ${client.name}"}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}-autoconfig.rsc"`);
        res.send(autoconfigScript);
    } catch (error) {
        log('error', 'autoconfig_error', { name: req.params.name, error: error.message });
        res.status(500).send("Failed to generate auto-config script");
    }
});

// Get all connected peers
app.get("/list-peers", async (req, res) => {
    try {
        const wgStatus = await wgLock.run(() => runWgCommand(['show']));
        res.json({ 
            success: true,
            peers: wgStatus 
        });
    } catch (error) {
        log('error', 'list_peers_error', { error: error.message });
        res.status(500).json({ 
            success: false,
            error: "Failed to list peers", 
            details: error.message 
        });
    }
});

// Add a new peer to WireGuard (manual method)
app.post("/add-peer", async (req, res) => {
    try {
        const { publicKey, allowedIPs } = req.body;

        if (!publicKey || !allowedIPs) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        // Phase 2.2: Validate inputs before passing to shell command
        if (!isValidWgKey(publicKey)) {
            return res.status(400).json({ error: "Invalid WireGuard public key format" });
        }
        if (!isValidCidr(allowedIPs)) {
            return res.status(400).json({ error: "Invalid CIDR format for allowedIPs" });
        }

        // Add peer dynamically without modifying wg0.conf
        await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allowedIPs, 'persistent-keepalive', String(KEEPALIVE_TIME)]));

        // Verify WireGuard status
        const wgStatus = await wgLock.run(() => runWgCommand(['show']));

        res.json({ message: "Peer added successfully", details: wgStatus });
    } catch (error) {
        log('error', 'add_peer_error', { error: error.message });
        res.status(500).json({ error: "Failed to add peer", details: error.message });
    }
});

// ==================== Client Management Endpoints ====================

// Get all clients from database with filtering, pagination, and search
app.get("/api/clients", async (req, res) => {
    try {
        if (!dbInitialized) {
            return res.status(503).json({
                success: false,
                error: "Database not initialized"
            });
        }
        
        const { 
            page = 1, 
            limit = 50, 
            enabled, 
            search,
            sortBy = 'createdAt',
            sortOrder = 'desc'
        } = req.query;
        
        // Build query
        const query = {};
        if (enabled !== undefined) {
            query.enabled = enabled === 'true';
        }
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { notes: { $regex: search, $options: 'i' } },
                { ip: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Calculate pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
        
        // Get clients and total count
        const [clients, total] = await Promise.all([
            Client.find(query)
                .sort(sort)
                .skip(skip)
                .limit(parseInt(limit)),
            Client.countDocuments(query)
        ]);
        
        const safeClients = clients.map(c => c.toSafeJSON());
        
        res.json({
            success: true,
            clients: safeClients,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        log('error', 'list_clients_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to list clients",
            details: error.message
        });
    }
});

// Legacy endpoint for backward compatibility
app.get("/clients", async (req, res) => {
    try {
        if (!dbInitialized) {
            return res.status(503).json({
                success: false,
                error: "Database not initialized"
            });
        }
        
        const clients = await Client.find({}).sort({ createdAt: -1 });
        const safeClients = clients.map(c => c.toSafeJSON());
        
        res.json({
            success: true,
            clients: safeClients,
            count: safeClients.length
        });
    } catch (error) {
        log('error', 'list_clients_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to list clients",
            details: error.message
        });
    }
});

// Get client details by name (admin - includes private key)
app.get("/api/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { includePrivateKey = 'false' } = req.query;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Return full details if requested, otherwise safe version
        const clientData = includePrivateKey === 'true' 
            ? client.toObject() 
            : client.toSafeJSON();
        
        res.json({
            success: true,
            data: clientData
        });
    } catch (error) {
        log('error', 'get_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to get client",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Get client WireGuard config file (.conf)
app.get("/api/clients/:name/config", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Get server's public key and endpoint
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = client.endpoint || getServerEndpoint();
        
        // Generate complete client configuration
        const dns = client.dns || "";
        const allowedIPs = client.allowedIPs || "0.0.0.0/0";
        const keepalive = validateKeepalive(client.persistentKeepalive);
        
        let clientConfig = `[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.ip}`;
        
        if (dns) {
            clientConfig += `\nDNS = ${dns}`;
        }
        
        clientConfig += `\n
[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverEndpoint}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = ${keepalive}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}.conf"`);
        res.send(clientConfig);
    } catch (error) {
        log('error', 'get_config_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to get client config",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Auto-Configure MikroTik (Single URL) - Enhanced version
app.get("/api/clients/:name/autoconfig", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = client.endpoint || getServerEndpoint();
        const serverEndpointParts = serverEndpoint.split(':');
        const serverHost = serverEndpointParts[0];
        const serverPort = serverEndpointParts[1] || '51820';
        
        const ifaceName = (client.interfaceName || `wg-client-${client.name}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const allowed = client.allowedIPs || "0.0.0.0/0";
        const dns = client.dns || "8.8.8.8, 1.1.1.1";
        const keepalive = validateKeepalive(client.persistentKeepalive);
        const serverWgIp = "10.0.0.1";
        
        // Generate smart MikroTik auto-config script with connectivity check
        const autoconfigScript = `# WireGuard Auto-Configuration Script
# Generated: ${new Date().toISOString()}
# Client: ${client.name}

# Variables
:local IFACE "${ifaceName}"
:local CLIENT_IP "${client.ip}"
:local SERVER_PUBKEY "${serverPublicKey}"
:local SERVER_HOST "${serverHost}"
:local SERVER_PORT "${serverPort}"
:local ALLOWED "${allowed}"
:local DNS_SERVERS "${dns.replace(/,/g, ',')}"
:local KEEPALIVE ${keepalive}
:local SERVER_WG_IP "${serverWgIp}"
:local CLIENT_PRIVKEY "${client.privateKey}"

# If interface already exists, test connectivity first
:if ([/interface/wireguard/print count-only where name=$IFACE] > 0) do={
    :put "WireGuard interface $IFACE already exists, testing connectivity..."
    :local success 0
    :do {
        /ping $SERVER_WG_IP count=3 timeout=2s
        :set success 1
    } on-error={ :set success 0 }

    :if ($success = 1) do={
        :put "WireGuard for client '${client.name}' already configured and working. No changes made."
        :return
    } else={
        :put "Existing WireGuard config for client '${client.name}' not working. Reinstalling..."

        # Remove routes using this interface
        /ip/route/remove [find where gateway=$IFACE]

        # Remove addresses on this interface
        /ip/address/remove [find where interface=$IFACE]

        # Remove peers on this interface
        /interface/wireguard/peers/remove [find where interface=$IFACE]

        # Remove the interface itself
        /interface/wireguard/remove [find name=$IFACE]
    }
}

# Create WireGuard interface
/interface/wireguard/add name=$IFACE listen-port=51820 mtu=1420 private-key="$CLIENT_PRIVKEY"

# Add peer configuration (server)
/interface/wireguard/peers/add interface=$IFACE public-key="$SERVER_PUBKEY" endpoint-address=$SERVER_HOST endpoint-port=$SERVER_PORT allowed-address=$ALLOWED persistent-keepalive=$KEEPALIVE

# Assign IP address to interface
/ip/address/add address=$CLIENT_IP interface=$IFACE

# Configure DNS
/ip/dns/set servers=$DNS_SERVERS

# Enable interface
/interface/wireguard/set $IFACE disabled=no

# Add routing if needed
/ip/route/add dst-address=$ALLOWED gateway=$IFACE comment="WireGuard VPN Route"

# Test connectivity
:delay 2
:local success 0
:do {
    /ping $SERVER_WG_IP count=3 timeout=2s
    :set success 1
} on-error={ :set success 0 }

# Success / fail message
:if ($success = 1) do={
    :put "WireGuard client '${client.name}' configured successfully! Ping to $SERVER_WG_IP succeeded."
} else={
    :put "WireGuard client '${client.name}' configured but ping to $SERVER_WG_IP failed. Check firewall/connectivity."
}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}-autoconfig.rsc"`);
        res.send(autoconfigScript);
    } catch (error) {
        log('error', 'autoconfig_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to generate auto-config script",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Ping remote server endpoint
app.post("/api/clients/:name/ping", async (req, res) => {
    try {
        const { name } = req.params;
        const { target = "10.0.0.1", count = 3 } = req.body;
        
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Ping the target
        try {
            const pingResult = await runCommand(`ping -c ${count} -W 2 ${target}`);
            res.json({
                success: true,
                message: `Ping to ${target} successful`,
                client: client.name,
                target: target,
                result: pingResult
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: `Ping to ${target} failed`,
                client: client.name,
                target: target,
                error: "PING_FAILED",
                details: error.message
            });
        }
    } catch (error) {
        log('error', 'ping_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to ping remote server",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Get client MikroTik script
app.get("/api/clients/:name/mikrotik", async (req, res) => {
    try {
        const { name } = req.params;
        const { iface, subnet } = req.query;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = client.endpoint || getServerEndpoint();
        const serverEndpointParts = serverEndpoint.split(':');
        const serverHost = serverEndpointParts[0];
        const serverPort = serverEndpointParts[1] || '51820';
        
        const ifaceName = (iface || client.interfaceName || `wireguard-${client.name}`).replace(/[^a-zA-Z0-9_-]/g, '-');
        const allowed = (subnet || client.allowedIPs || "0.0.0.0/0").toString();
        const keepalive = validateKeepalive(client.persistentKeepalive);
        
        // Generate MikroTik script
        const mikrotikScript = `:local IFACE "${ifaceName}";:local PRIV "${client.privateKey}";:local IP "${client.ip}";:local SPK "${serverPublicKey}";:local HOST "${serverHost}";:local PORT "${serverPort}";:local ALLOW "${allowed}";:local LP 51810;:for i from=0 to=32 do={:local T ($LP+$i);:if ([/interface wireguard print count-only where listen-port=$T]=0) do={:set LP $T;:set i 33}};:if ([/interface wireguard print count-only where name=$IFACE]=0) do={/interface wireguard add name=$IFACE};/interface wireguard set [find where name=$IFACE] private-key=$PRIV listen-port=$LP;/interface wireguard enable [find where name=$IFACE];:if ([/ip address print count-only where address=$IP]=0) do={/ip address add address=$IP interface=$IFACE disabled=no};:local PID [/interface wireguard peers find where interface=$IFACE public-key=$SPK];:if ([:len $PID]=0) do={/interface wireguard peers add interface=$IFACE public-key=$SPK endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}} else={/interface wireguard peers set $PID endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}};:if ([/ip route print count-only where dst-address=$ALLOW gateway=$IFACE]=0) do={/ip route add dst-address=$ALLOW gateway=$IFACE disabled=no};:delay 2;:local ok 0;:do {/ping 10.0.0.1 count=3;:set ok 1} on-error={:set ok 0};:if ($ok=1) do={:put "OK ${client.name} $IFACE $IP $LP"} else={:put "FAIL ${client.name}"}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}.rsc"`);
        res.send(mikrotikScript);
    } catch (error) {
        log('error', 'get_mikrotik_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to get MikroTik script",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Legacy endpoint for backward compatibility
app.get("/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                error: `Client "${name}" not found`
            });
        }
        
        // Get server's public key and endpoint
        const serverPublicKey = (await getServerPublicKey()).trim();
        const serverEndpoint = getServerEndpoint();
        
        // Generate complete client configuration
        const clientConfig = `[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.ip}

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverEndpoint}
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = ${KEEPALIVE_TIME}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}.conf"`);
        res.send(clientConfig);
    } catch (error) {
        log('error', 'get_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to get client",
            details: error.message
        });
    }
});

// Create new client (admin)
app.post("/api/clients", async (req, res) => {
    try {
        const { 
            name, 
            notes, 
            interfaceName, 
            allowedIPs = "0.0.0.0/0",
            endpoint,
            dns,
            persistentKeepalive = KEEPALIVE_TIME,
            enabled = true 
        } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Name is required",
                error: "VALIDATION_ERROR"
            });
        }
        
        const clientName = name.toLowerCase().trim();
        
        // Validate IP format if provided
        if (allowedIPs && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(allowedIPs) && allowedIPs !== "0.0.0.0/0") {
            return res.status(400).json({
                success: false,
                message: "Invalid allowedIPs format",
                error: "INVALID_IP"
            });
        }
        
        // Check if client already exists
        const existing = await Client.findOne({ name: clientName });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: `Client "${clientName}" already exists`,
                error: "CLIENT_EXISTS"
            });
        }
        
        // Generate keys
        const { privateKey, publicKey } = await generateKeys();
        const allocatedIp = await getNextAvailableIP();
        
        // Create client
        const client = new Client({
            name: clientName,
            ip: allocatedIp,
            publicKey,
            privateKey,
            enabled,
            notes: notes || '',
            interfaceName: interfaceName || `wireguard-${clientName}`,
            endpoint: endpoint || getServerEndpoint(),
            allowedIPs: allowedIPs,
            dns: dns,
            persistentKeepalive: persistentKeepalive
        });
        
        await client.save();
        
        // Add to WireGuard if enabled
        if (enabled) {
            try {
                const keepalive = validateKeepalive(persistentKeepalive);
                await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allocatedIp, 'persistent-keepalive', String(keepalive)]));
                log('info', 'peer_added', { client: clientName });
            } catch (error) {
                log('warn', 'peer_add_failed', { client: clientName, error: error.message });
            }
        }
        
        res.status(201).json({
            success: true,
            message: "Client created successfully",
            data: {
                _id: client._id,
                name: client.name,
                publicKey: client.publicKey,
                privateKey: client.privateKey,
                ip: client.ip,
                enabled: client.enabled,
                createdAt: client.createdAt
            }
        });
    } catch (error) {
        log('error', 'create_client_error', { error: error.message });
        
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "Client with this name or IP already exists",
                error: "CLIENT_EXISTS",
                field: Object.keys(error.keyPattern || {})[0]
            });
        }
        
        res.status(500).json({
            success: false,
            message: "Failed to create client",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Full update client (admin)
app.put("/api/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { 
            notes, 
            interfaceName, 
            enabled,
            ip,
            allowedIPs,
            endpoint,
            dns,
            persistentKeepalive
        } = req.body;
        
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Validate IP format if provided
        if (ip && !/^10\.0\.0\.\d{1,3}\/32$/.test(ip)) {
            return res.status(400).json({
                success: false,
                message: "Invalid IP format. Must be in format 10.0.0.X/32",
                error: "INVALID_IP"
            });
        }
        
        if (allowedIPs && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(allowedIPs) && allowedIPs !== "0.0.0.0/0") {
            return res.status(400).json({
                success: false,
                message: "Invalid allowedIPs format",
                error: "INVALID_IP"
            });
        }
        
        // Update fields
        const updateData = {};
        if (notes !== undefined) updateData.notes = notes;
        if (interfaceName !== undefined) updateData.interfaceName = interfaceName;
        if (typeof enabled === 'boolean') updateData.enabled = enabled;
        if (ip !== undefined) updateData.ip = ip;
        if (allowedIPs !== undefined) updateData.allowedIPs = allowedIPs;
        if (endpoint !== undefined) updateData.endpoint = endpoint;
        if (dns !== undefined) updateData.dns = dns;
        if (persistentKeepalive !== undefined) updateData.persistentKeepalive = validateKeepalive(persistentKeepalive);
        
        const updatedClient = await Client.findOneAndUpdate(
            { name: name.toLowerCase() },
            updateData,
            { new: true }
        );
        
        // Update WireGuard if enabled status changed or IP changed
        if (typeof enabled === 'boolean' || ip !== undefined) {
            if (enabled !== false && updatedClient.enabled) {
                try {
                    const keepalive = validateKeepalive(updatedClient.persistentKeepalive);
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', updatedClient.publicKey, 'allowed-ips', updatedClient.ip, 'persistent-keepalive', String(keepalive)]));
                    log('info', 'peer_updated', { client: name });
                } catch (error) {
                    log('warn', 'peer_update_failed', { client: name, error: error.message });
                }
            } else if (enabled === false) {
                try {
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', updatedClient.publicKey, 'remove']));
                    log('info', 'peer_disabled', { client: name });
                } catch (error) {
                    log('warn', 'peer_disable_failed', { client: name, error: error.message });
                }
                
                // Clear statistics for disabled client
                await Client.updateOne(
                    { _id: updatedClient._id },
                    {
                        $set: {
                            lastHandshake: null,
                            lastConnectionTime: null,
                            lastConnectionIp: null,
                            transferRx: 0,
                            transferTx: 0
                        }
                    }
                );
            }
        }
        
        res.json({
            success: true,
            message: "Client updated successfully"
        });
    } catch (error) {
        log('error', 'update_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to update client",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Regenerate client keys (admin)
app.post("/api/clients/:name/regenerate", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                error: `Client "${name}" not found`
            });
        }
        
        // Remove old peer from WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
        } catch (error) {
            log('warn', 'peer_remove_failed', { client: name, error: error.message });
        }
        
        // Generate new keys
        const { privateKey, publicKey } = await generateKeys();
        
        // Update client
        client.privateKey = privateKey;
        client.publicKey = publicKey;
        await client.save();
        
        // Add new peer to WireGuard if enabled
        if (client.enabled) {
            try {
                const keepalive = validateKeepalive(client.persistentKeepalive);
                await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', client.ip, 'persistent-keepalive', String(keepalive)]));
                log('info', 'peer_regenerated', { client: name });
            } catch (error) {
                log('warn', 'peer_regenerate_add_failed', { client: name, error: error.message });
            }
        }
        
        res.json({
            success: true,
            message: "Keys regenerated successfully",
            data: {
                publicKey: client.publicKey,
                privateKey: client.privateKey
            }
        });
    } catch (error) {
        log('error', 'regenerate_keys_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to regenerate client keys",
            details: error.message
        });
    }
});

// Enable client
app.post("/api/clients/:name/enable", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOneAndUpdate(
            { name: name.toLowerCase() },
            { enabled: true },
            { new: true }
        );
        
        if (!client) {
            return res.status(404).json({
                success: false,
                error: `Client "${name}" not found`
            });
        }
        
        // Add to WireGuard
        try {
            const keepalive = validateKeepalive(client.persistentKeepalive);
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'allowed-ips', client.ip, 'persistent-keepalive', String(keepalive)]));
            log('info', 'peer_enabled', { client: name });
        } catch (error) {
            log('warn', 'peer_enable_failed', { client: name, error: error.message });
        }
        
        res.json({
            success: true,
            message: "Client enabled successfully"
        });
    } catch (error) {
        log('error', 'enable_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to enable client",
            details: error.message
        });
    }
});

// Disable client
app.post("/api/clients/:name/disable", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOneAndUpdate(
            { name: name.toLowerCase() },
            { enabled: false },
            { new: true }
        );
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Remove from WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            log('info', 'peer_disabled', { client: name });
        } catch (error) {
            log('warn', 'peer_disable_failed', { client: name, error: error.message });
        }
        
        // Clear statistics for disabled client
        await Client.updateOne(
            { _id: client._id },
            {
                $set: {
                    lastHandshake: null,
                    lastConnectionTime: null,
                    lastConnectionIp: null,
                    transferRx: 0,
                    transferTx: 0
                }
            }
        );
        
        res.json({
            success: true,
            message: "Client disabled successfully"
        });
    } catch (error) {
        log('error', 'disable_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to disable client",
            details: error.message
        });
    }
});

// Delete client
app.delete("/api/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                message: `Client "${name}" not found`,
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Remove from WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            log('info', 'peer_removed', { client: name });
        } catch (error) {
            log('warn', 'peer_remove_failed', { client: name });
        }
        
        // Delete from database
        await Client.deleteOne({ name: name.toLowerCase() });
        
        res.json({
            success: true,
            message: "Client deleted successfully"
        });
    } catch (error) {
        log('error', 'delete_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to delete client",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Bulk delete clients
app.post("/api/clients/bulk-delete", async (req, res) => {
    try {
        const { names } = req.body;
        
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Names array is required and must not be empty",
                error: "VALIDATION_ERROR"
            });
        }
        
        const lowerNames = names.map(n => n.toLowerCase());
        const clients = await Client.find({ name: { $in: lowerNames } });
        
        if (clients.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No clients found to delete",
                error: "CLIENT_NOT_FOUND"
            });
        }
        
        // Remove from WireGuard
        for (const client of clients) {
            try {
                await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            } catch (error) {
                log('warn', 'peer_remove_failed', { client: client.name });
            }
        }
        
        // Delete from database
        const result = await Client.deleteMany({ name: { $in: lowerNames } });
        
        res.json({
            success: true,
            message: `Deleted ${result.deletedCount} client(s) successfully`,
            deleted: result.deletedCount,
            clients: clients.map(c => ({ name: c.name, ip: c.ip }))
        });
    } catch (error) {
        log('error', 'bulk_delete_error', { error: error.message });
        res.status(500).json({
            success: false,
            message: "Failed to delete clients",
            error: "WIREGUARD_ERROR",
            details: error.message
        });
    }
});

// Get admin statistics
app.get("/api/admin/stats", async (req, res) => {
    try {
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
            wgStatus = {
                connected: 0,
                error: "WireGuard interface not available"
            };
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

// Helper function to get time ago string
function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
}

// Update client (enable/disable, notes) - Legacy
app.patch("/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { enabled, notes } = req.body;
        
        const updateData = {};
        if (typeof enabled === 'boolean') updateData.enabled = enabled;
        if (notes !== undefined) updateData.notes = notes;
        
        const client = await Client.findOneAndUpdate(
            { name: name.toLowerCase() },
            updateData,
            { new: true }
        );
        
        if (!client) {
            return res.status(404).json({
                success: false,
                error: `Client "${name}" not found`
            });
        }
        
        // If enabling/disabling, update WireGuard
        if (typeof enabled === 'boolean') {
            if (enabled) {
                // Add to WireGuard
                try {
                    const keepalive = validateKeepalive(client.persistentKeepalive);
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'allowed-ips', client.ip, 'persistent-keepalive', String(keepalive)]));
                    log('info', 'peer_enabled', { client: client.name });
                } catch (error) {
                    log('warn', 'peer_enable_failed', { client: client.name, error: error.message });
                }
            } else {
                // Remove from WireGuard
                try {
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
                    log('info', 'peer_disabled', { client: client.name });
                } catch (error) {
                    log('warn', 'peer_disable_failed', { client: client.name, error: error.message });
                }
                
                // Clear statistics for disabled client
                await Client.updateOne(
                    { _id: client._id },
                    {
                        $set: {
                            lastHandshake: null,
                            lastConnectionTime: null,
                            lastConnectionIp: null,
                            transferRx: 0,
                            transferTx: 0
                        }
                    }
                );
            }
        }
        
        res.json({
            success: true,
            message: `Client "${name}" updated successfully`,
            client: client.toSafeJSON()
        });
    } catch (error) {
        log('error', 'update_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to update client",
            details: error.message
        });
    }
});

// Delete client
app.delete("/clients/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const client = await Client.findOne({ name: name.toLowerCase() });
        
        if (!client) {
            return res.status(404).json({
                success: false,
                error: `Client "${name}" not found`
            });
        }
        
        // Remove from WireGuard
        try {
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            log('info', 'peer_removed', { client: name });
        } catch (error) {
            log('warn', 'peer_remove_failed', { client: name });
        }
        
        // Delete from database
        await Client.deleteOne({ name: name.toLowerCase() });
        
        res.json({
            success: true,
            message: `Client "${name}" deleted successfully`,
            deletedClient: {
                name: client.name,
                ip: client.ip
            }
        });
    } catch (error) {
        log('error', 'delete_client_error', { error: error.message });
        res.status(500).json({
            success: false,
            error: "Failed to delete client",
            details: error.message
        });
    }
});

// Manual reload from database
app.post("/reload", async (req, res) => {
    try {
        await loadClientsFromDatabase();
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

// Health check endpoint
app.get("/", (req, res) => {
    res.json({ 
        status: "running",
        service: "WireGuard VPN Management API",
        database: dbInitialized ? "connected" : "not connected",
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
            database: dbInitialized ? "connected" : "disconnected",
            wireguard: null,
            stalePeers: []
        };
        
        // Check WireGuard status and peer handshake health
        try {
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
            health.wireguard = "not running";
            health.wireguardError = error.message;
        }
        
        const statusCode = (dbInitialized && health.wireguard === "running") ? 200 : 503;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(503).json({
            status: "unhealthy",
            error: error.message
        });
    }
});

// Run API on TCP Port (default 5000, can be overridden via PORT env var)
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => log('info', 'server_started', { port: PORT }));
