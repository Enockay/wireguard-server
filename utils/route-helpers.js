const { execFile } = require("child_process");
const fs = require("fs");
const Client = require("../models/Client");
const {
    wgLock,
    log,
    KEEPALIVE_TIME,
    STARTING_CLIENT_IP,
    isValidWgKey,
    isValidCidr,
    validateKeepalive,
    runWgCommand
} = require("../wg-core");

// Generate WireGuard keys (uses execFile, no shell needed)
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
    // Validate generated keys to catch corruption
    if (!isValidWgKey(privateKey) || !isValidWgKey(publicKey)) {
        throw new Error('Key generation produced invalid keys');
    }
    return { privateKey, publicKey };
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
async function getNextAvailableIP(dbInitialized) {
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

// Load clients from database and apply to WireGuard using wg addconf
async function loadClientsFromDatabase(dbInitialized) {
    if (!dbInitialized) {
        log('warn', 'db_not_initialized', { action: 'skip_client_load' });
        return;
    }
    
    try {
        const clients = await Client.find({ enabled: true });
        log('info', 'syncconf_start', { clientCount: clients.length });
        
        // Build wg config with only [Peer] sections (no [Interface])
        // Skip clients with invalid keys/IPs (defense-in-depth)
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
        // Use addconf (not syncconf) -- syncconf with a peers-only file strips
        // the interface's private key and listen port, breaking all handshakes.
        // addconf only adds/updates peers without touching the interface config.
        await wgLock.run(() => runWgCommand(['addconf', 'wg0', tmpFile]));
        fs.unlinkSync(tmpFile);
        
        log('info', 'peers_loaded', { synced: clients.length - skipped, total: clients.length });
    } catch (error) {
        log('error', 'load_clients_failed', { error: error.message });
    }
}
// Ensure a client exists (create if missing) and return its record
async function ensureClientRecord({ name, notes, interfaceName }, dbInitialized) {
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
    const allocatedIpWithCidr = await getNextAvailableIP(dbInitialized);
    const record = new Client({
        name: clientName,
        ip: allocatedIpWithCidr,
        publicKey,
        privateKey,
        enabled: true,
        notes: notes || '',
        interfaceName: interfaceName || `wireguard-${clientName}`,
        endpoint: require("../wg-core").getServerEndpoint(),
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

module.exports = {
    generateKeys,
    getUsedIPs,
    getNextAvailableIP,
    loadClientsFromDatabase,
    ensureClientRecord,
    getTimeAgo
};
