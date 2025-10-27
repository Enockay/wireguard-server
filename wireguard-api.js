const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const db = require("./db");
const Client = require("./models/Client");

const app = express();
app.use(bodyParser.json());

const KEEPALIVE_TIME = 25; // Keepalive interval (in seconds)
const STARTING_CLIENT_IP = 6; // Start assigning IPs from 10.0.0.6 (1=server, 2-5=preconfigured)

// Initialize MongoDB connection
let dbInitialized = false;
(async () => {
    try {
        await db.connect();
        dbInitialized = true;
        console.log("✅ Database initialized, loading clients...");
        // Load and apply all enabled clients from database
        await loadClientsFromDatabase();
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
                await runCommand(`wg set wg0 peer ${client.publicKey} allowed-ips ${client.ip} persistent-keepalive ${KEEPALIVE_TIME}`);
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

// Get all clients from database
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

// Get client by name
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

// Update client (enable/disable, notes)
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
                    await runCommand(`wg set wg0 peer ${client.publicKey} allowed-ips ${client.ip} persistent-keepalive ${KEEPALIVE_TIME}`);
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
        endpoints: {
            "POST /generate-client": "Generate new client (requires name in body)",
            "GET /clients": "List all clients",
            "GET /clients/:name": "Get client config by name",
            "PATCH /clients/:name": "Update client (enable/disable, notes)",
            "DELETE /clients/:name": "Delete client",
            "POST /reload": "Reload all clients from database",
            "POST /add-peer": "Add peer manually",
            "GET /list-peers": "List active connections"
        }
    });
});

// Run API on TCP Port 5000
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ WireGuard API running on port ${PORT}`));
