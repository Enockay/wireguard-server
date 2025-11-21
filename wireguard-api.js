const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const db = require("./db");
const Client = require("./models/Client");

const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(bodyParser.json());

const KEEPALIVE_TIME = 25; // Keepalive interval (in seconds)
const STARTING_CLIENT_IP = 6; // Start assigning IPs from 10.0.0.6 (1=server, 2-5=preconfigured)
const STATS_UPDATE_INTERVAL = 30000; // Update statistics every 30 seconds

// Initialize MongoDB connection
let dbInitialized = false;
(async () => {
    try {
        await db.connect();
        dbInitialized = true;
        console.log("✅ Database initialized, loading clients...");
        // Load and apply all enabled clients from database
        await loadClientsFromDatabase();
        // Start background statistics update job
        startStatisticsUpdateJob();
    } catch (error) {
        console.error("❌ Failed to initialize database:", error.message);
        dbInitialized = false;
    }
})();

// Function to execute shell commands safely
function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Command execution error: ${stderr}`);
                return reject(stderr);
            }
            resolve(stdout);
        });
    });
}

// Generate WireGuard keys
async function generateKeys() {
    const privateKey = (await runCommand("wg genkey")).trim();
    const publicKey = (await runCommand(`echo "${privateKey}" | wg pubkey`)).trim();
    return {
        privateKey: privateKey,
        publicKey: publicKey
    };
}

// Load clients from database and apply to WireGuard
async function loadClientsFromDatabase() {
    if (!dbInitialized) {
        console.log("⚠️  Database not initialized, skipping client load");
        return;
    }
    
    try {
        const clients = await Client.find({ enabled: true });
        console.log(`🔄 Loading ${clients.length} enabled clients from database...`);
        
        for (const client of clients) {
            try {
                const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
                await runCommand(`wg set wg0 peer ${client.publicKey} allowed-ips ${client.ip} persistent-keepalive ${keepalive}`);
                console.log(`✅ Loaded client: ${client.name} (${client.ip})`);
            } catch (error) {
                console.warn(`⚠️  Could not load client ${client.name}: ${error.message}`);
            }
        }
        
        console.log(`✅ Successfully loaded ${clients.length} clients from database`);
    } catch (error) {
        console.error("❌ Error loading clients from database:", error.message);
    }
}

// Get all currently used IPs from WireGuard
async function getUsedIPs() {
    try {
        const wgShow = await runCommand("wg show wg0 dump");
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
        console.error("Error getting next available IP:", error);
        throw error;
    }
}

// Get server's public key
async function getServerPublicKey() {
    try {
        return await runCommand("wg show wg0 public-key");
    } catch (error) {
        // If wireguard is not running yet, return placeholder
        return "REPLACE_WITH_SERVER_PUBLIC_KEY";
    }
}

// Get server endpoint (IP or domain)
function getServerEndpoint() {
    return process.env.SERVER_ENDPOINT || "YOUR_SERVER_IP:51820";
}

// Update client statistics from WireGuard interface
async function updateClientStatistics() {
    if (!dbInitialized) {
        return;
    }
    
    try {
        // Get WireGuard interface dump
        const wgShow = await runCommand("wg show wg0 dump");
        const lines = wgShow.trim().split('\n').filter(line => line.trim());
        
        // Get all enabled clients to update
        const enabledClients = await Client.find({ enabled: true });
        const enabledPublicKeys = new Set(enabledClients.map(c => c.publicKey.trim()));
        
        // Process active peers from WireGuard
        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length < 7) continue;
            
            const [
                publicKey,
                endpoint,
                allowedIPs,
                lastHandshake,
                transferRx,
                transferTx,
                persistentKeepalive
            ] = parts;
            
            const publicKeyTrimmed = publicKey.trim();
            
            // Only update statistics for enabled clients
            if (!enabledPublicKeys.has(publicKeyTrimmed)) {
                continue;
            }
            
            // Find client by public key
            const client = await Client.findOne({ publicKey: publicKeyTrimmed, enabled: true });
            if (!client) continue;
            
            // Parse endpoint to get IP
            const endpointIp = endpoint && endpoint !== '(none)' && endpoint.trim() !== ''
                ? endpoint.split(':')[0].trim()
                : null;
            
            // Parse handshake time (Unix timestamp in seconds) with proper validation
            let handshakeTime = null;
            if (lastHandshake && lastHandshake.trim() !== '' && lastHandshake.trim() !== '0') {
                const handshakeSeconds = parseInt(lastHandshake.trim());
                // Validate: must be a valid number and within reasonable range (not before 2020, not in future)
                if (!isNaN(handshakeSeconds) && handshakeSeconds > 0) {
                    const date = new Date(handshakeSeconds * 1000);
                    const now = new Date();
                    const minDate = new Date('2020-01-01');
                    // Only accept if date is valid, after 2020, and not in the future
                    if (date instanceof Date && !isNaN(date.getTime()) && date >= minDate && date <= now) {
                        handshakeTime = date;
                    }
                }
            }
            
            // Parse transfer values (they're in bytes)
            const rxBytes = parseInt(transferRx && transferRx.trim() !== '' ? transferRx.trim() : '0') || 0;
            const txBytes = parseInt(transferTx && transferTx.trim() !== '' ? transferTx.trim() : '0') || 0;
            
            // Update client statistics
            const updateData = {
                transferRx: rxBytes,
                transferTx: txBytes,
                updatedAt: new Date()
            };
            
            if (handshakeTime) {
                updateData.lastHandshake = handshakeTime;
                updateData.lastConnectionTime = handshakeTime;
            }
            
            if (endpointIp) {
                updateData.lastConnectionIp = endpointIp;
            }
            
            await Client.updateOne(
                { publicKey: publicKeyTrimmed },
                { $set: updateData }
            );
        }
        
        // Clear statistics for disabled clients that might still be in WireGuard
        // (in case they weren't properly removed)
        const allClients = await Client.find({ enabled: false });
        for (const disabledClient of allClients) {
            // Check if this client is still in WireGuard
            const stillInWg = lines.some(line => {
                const parts = line.split('\t');
                return parts.length > 0 && parts[0].trim() === disabledClient.publicKey.trim();
            });
            
            // If still in WireGuard, try to remove it
            if (stillInWg) {
                try {
                    await runCommand(`wg set wg0 peer ${disabledClient.publicKey} remove`);
                    console.log(`✅ Removed disabled client ${disabledClient.name} from WireGuard`);
                } catch (error) {
                    // Ignore errors - peer might already be removed
                }
            }
            
            // Clear statistics for disabled clients
            await Client.updateOne(
                { _id: disabledClient._id },
                { 
                    $set: {
                        lastHandshake: null,
                        lastConnectionTime: null,
                        lastConnectionIp: null,
                        transferRx: 0,
                        transferTx: 0,
                        updatedAt: new Date()
                    }
                }
            );
        }
    } catch (error) {
        // Silently fail - WireGuard might not be running
        if (error.message && !error.message.includes('No such device')) {
            console.error('Error updating statistics:', error.message);
        }
    }
}

// Start background job to update statistics
function startStatisticsUpdateJob() {
    // Run immediately
    updateClientStatistics();
    
    // Then run every 30 seconds
    setInterval(updateClientStatistics, STATS_UPDATE_INTERVAL);
    console.log(`✅ Statistics update job started (runs every ${STATS_UPDATE_INTERVAL/1000}s)`);
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
        console.log(`🔐 Generating new WireGuard client for "${clientName}"...`);
        
        // Generate client keys
        const { privateKey, publicKey } = await generateKeys();
        console.log(`✅ Generated keys for client`);
        
        // Get next available IP
        const allowedIPs = await getNextAvailableIP();
        console.log(`✅ Assigned IP: ${allowedIPs}`);
        
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
        console.log(`✅ Saved client "${clientName}" to database`);
        
        // Add peer to WireGuard
        try {
            await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allowedIPs} persistent-keepalive ${KEEPALIVE_TIME}`);
            console.log(`✅ Added peer to WireGuard`);
        } catch (error) {
            console.warn("⚠️  Could not add peer to WireGuard (might not be running yet), but saved to database");
        }
        
        // Get server's public key
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
        
        console.log(`✅ Client configuration generated successfully`);
        
        // Set content type for WireGuard config file
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${clientName}.conf"`);
        
        // Send the config file directly
        res.send(clientConfig);
        
    } catch (error) {
        console.error("❌ Error generating client:", error);
        
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
            await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allocatedIpWithCidr} persistent-keepalive ${KEEPALIVE_TIME}`);
        } catch (error) {
            // Proceed even if wg0 is not yet up; DB has the record
            console.warn("⚠️  Could not add peer to running WireGuard:", error?.message || error);
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
        console.error("❌ Error generating MikroTik script:", error);
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
        await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allocatedIpWithCidr} persistent-keepalive ${KEEPALIVE_TIME}`);
    } catch (e) {
        console.warn("⚠️  wg set failed (ensureClientRecord):", e?.message || e);
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
        console.error("❌ /mt/:name error", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Get all connected peers
app.get("/list-peers", async (req, res) => {
    try {
        const wgStatus = await runCommand("wg show");
        res.json({ 
            success: true,
            peers: wgStatus 
        });
    } catch (error) {
        console.error("❌ Error listing peers:", error);
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

        // Add peer dynamically without modifying wg0.conf
        await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allowedIPs} persistent-keepalive ${KEEPALIVE_TIME}`);

        // Verify WireGuard status
        const wgStatus = await runCommand("wg show");

        res.json({ message: "Peer added successfully", details: wgStatus });
    } catch (error) {
        console.error("❌ Error adding peer:", error);
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
        console.error("❌ Error listing clients:", error);
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
        console.error("❌ Error listing clients:", error);
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
        console.error("❌ Error getting client:", error);
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
        const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
        
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
        console.error("❌ Error getting client config:", error);
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
        const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
        const serverWgIp = "10.0.0.1";
        
        // Generate comprehensive MikroTik auto-config script
        const autoconfigScript = `# WireGuard Auto-Configuration Script
# Generated: ${new Date().toISOString()}
# Client: ${client.name}

# Remove existing interface if present
/interface/wireguard/remove [find name="${ifaceName}"]

# Create WireGuard interface
/interface/wireguard/add name=${ifaceName} listen-port=51820 mtu=1420 private-key="${client.privateKey}"

# Add peer configuration
/interface/wireguard/peers/add interface=${ifaceName} public-key="${serverPublicKey}" endpoint-address=${serverHost} endpoint-port=${serverPort} allowed-address=${allowed} persistent-keepalive=${keepalive}s

# Assign IP address
/ip/address/add address=${client.ip} interface=${ifaceName}

# Configure DNS
/ip/dns/set servers=${dns.replace(/,/g, ',')}

# Enable interface
/interface/wireguard/set ${ifaceName} disabled=no

# Add routing if needed
/ip/route/add dst-address=${allowed} gateway=${ifaceName} comment="WireGuard VPN Route"

# Test connectivity
:delay 2
:local success 0
:do {
  /ping ${serverWgIp} count=3 timeout=2s
  :set success 1
} on-error={ :set success 0 }

# Success message
:if ($success = 1) do={ 
  :put "WireGuard client '${client.name}' configured successfully! Ping to ${serverWgIp} succeeded."
} else={ 
  :put "WireGuard client '${client.name}' configured but ping to ${serverWgIp} failed. Check firewall/connectivity."
}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}-autoconfig.rsc"`);
        res.send(autoconfigScript);
    } catch (error) {
        console.error("❌ Error generating auto-config:", error);
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
        console.error("❌ Error pinging:", error);
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
        const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
        
        // Generate MikroTik script
        const mikrotikScript = `:local IFACE "${ifaceName}";:local PRIV "${client.privateKey}";:local IP "${client.ip}";:local SPK "${serverPublicKey}";:local HOST "${serverHost}";:local PORT "${serverPort}";:local ALLOW "${allowed}";:local LP 51810;:for i from=0 to=32 do={:local T ($LP+$i);:if ([/interface wireguard print count-only where listen-port=$T]=0) do={:set LP $T;:set i 33}};:if ([/interface wireguard print count-only where name=$IFACE]=0) do={/interface wireguard add name=$IFACE};/interface wireguard set [find where name=$IFACE] private-key=$PRIV listen-port=$LP;/interface wireguard enable [find where name=$IFACE];:if ([/ip address print count-only where address=$IP]=0) do={/ip address add address=$IP interface=$IFACE disabled=no};:local PID [/interface wireguard peers find where interface=$IFACE public-key=$SPK];:if ([:len $PID]=0) do={/interface wireguard peers add interface=$IFACE public-key=$SPK endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}} else={/interface wireguard peers set $PID endpoint-address=$HOST endpoint-port=$PORT allowed-address=$ALLOW persistent-keepalive=${keepalive}};:if ([/ip route print count-only where dst-address=$ALLOW gateway=$IFACE]=0) do={/ip route add dst-address=$ALLOW gateway=$IFACE disabled=no};:delay 2;:local ok 0;:do {/ping 10.0.0.1 count=3;:set ok 1} on-error={:set ok 0};:if ($ok=1) do={:put "OK ${client.name} $IFACE $IP $LP"} else={:put "FAIL ${client.name}"}`;
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${client.name}.rsc"`);
        res.send(mikrotikScript);
    } catch (error) {
        console.error("❌ Error getting MikroTik script:", error);
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
        console.error("❌ Error getting client:", error);
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
                await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allocatedIp} persistent-keepalive ${persistentKeepalive}`);
                console.log(`✅ Added client ${clientName} to WireGuard`);
            } catch (error) {
                console.warn(`⚠️  Could not add client to WireGuard: ${error.message}`);
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
        console.error("❌ Error creating client:", error);
        
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
        if (persistentKeepalive !== undefined) updateData.persistentKeepalive = persistentKeepalive;
        
        const updatedClient = await Client.findOneAndUpdate(
            { name: name.toLowerCase() },
            updateData,
            { new: true }
        );
        
        // Update WireGuard if enabled status changed or IP changed
        if (typeof enabled === 'boolean' || ip !== undefined) {
            if (enabled !== false && updatedClient.enabled) {
                try {
                    const keepalive = updatedClient.persistentKeepalive || KEEPALIVE_TIME;
                    await runCommand(`wg set wg0 peer ${updatedClient.publicKey} allowed-ips ${updatedClient.ip} persistent-keepalive ${keepalive}`);
                    console.log(`✅ Updated client ${name} in WireGuard`);
                } catch (error) {
                    console.warn(`⚠️  Could not update client in WireGuard: ${error.message}`);
                }
            } else if (enabled === false) {
                try {
                    await runCommand(`wg set wg0 peer ${updatedClient.publicKey} remove`);
                    console.log(`✅ Disabled client ${name} in WireGuard`);
                } catch (error) {
                    console.warn(`⚠️  Could not disable client in WireGuard: ${error.message}`);
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
        console.error("❌ Error updating client:", error);
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
            await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
        } catch (error) {
            console.warn(`⚠️  Could not remove old peer: ${error.message}`);
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
                const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
                await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${client.ip} persistent-keepalive ${keepalive}`);
                console.log(`✅ Added regenerated client ${name} to WireGuard`);
            } catch (error) {
                console.warn(`⚠️  Could not add regenerated client to WireGuard: ${error.message}`);
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
        console.error("❌ Error regenerating client keys:", error);
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
            const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
            await runCommand(`wg set wg0 peer ${client.publicKey} allowed-ips ${client.ip} persistent-keepalive ${keepalive}`);
            console.log(`✅ Enabled client ${name} in WireGuard`);
        } catch (error) {
            console.warn(`⚠️  Could not enable client in WireGuard: ${error.message}`);
        }
        
        res.json({
            success: true,
            message: "Client enabled successfully"
        });
    } catch (error) {
        console.error("❌ Error enabling client:", error);
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
            await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
            console.log(`✅ Disabled client ${name} in WireGuard`);
        } catch (error) {
            console.warn(`⚠️  Could not disable client in WireGuard: ${error.message}`);
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
        console.error("❌ Error disabling client:", error);
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
            await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
            console.log(`✅ Removed peer from WireGuard`);
        } catch (error) {
            console.warn("⚠️  Could not remove peer from WireGuard");
        }
        
        // Delete from database
        await Client.deleteOne({ name: name.toLowerCase() });
        
        res.json({
            success: true,
            message: "Client deleted successfully"
        });
    } catch (error) {
        console.error("❌ Error deleting client:", error);
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
                await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
            } catch (error) {
                console.warn(`⚠️  Could not remove peer ${client.name} from WireGuard`);
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
        console.error("❌ Error bulk deleting clients:", error);
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
            const wgShow = await runCommand("wg show wg0 dump");
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
        console.error("❌ Error getting stats:", error);
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
                    const keepalive = client.persistentKeepalive || KEEPALIVE_TIME;
                    await runCommand(`wg set wg0 peer ${client.publicKey} allowed-ips ${client.ip} persistent-keepalive ${keepalive}`);
                    console.log(`✅ Enabled client ${client.name} in WireGuard`);
                } catch (error) {
                    console.warn(`⚠️  Could not enable client in WireGuard: ${error.message}`);
                }
            } else {
                // Remove from WireGuard
                try {
                    await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
                    console.log(`✅ Disabled client ${client.name} in WireGuard`);
                } catch (error) {
                    console.warn(`⚠️  Could not disable client in WireGuard: ${error.message}`);
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
        console.error("❌ Error updating client:", error);
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
            await runCommand(`wg set wg0 peer ${client.publicKey} remove`);
            console.log(`✅ Removed peer from WireGuard`);
        } catch (error) {
            console.warn("⚠️  Could not remove peer from WireGuard");
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
        console.error("❌ Error deleting client:", error);
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
        console.error("❌ Error reloading clients:", error);
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

// Enhanced health check
app.get("/api/health", async (req, res) => {
    try {
        const health = {
            status: "healthy",
            timestamp: new Date().toISOString(),
            service: "WireGuard VPN Management API",
            database: dbInitialized ? "connected" : "disconnected",
            wireguard: null
        };
        
        // Check WireGuard status
        try {
            await runCommand("wg show wg0");
            health.wireguard = "running";
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

// Run API on TCP Port 5000
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ WireGuard API running on port ${PORT}`));
