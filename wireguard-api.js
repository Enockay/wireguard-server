const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");

const app = express();
app.use(bodyParser.json());

const KEEPALIVE_TIME = 25; // Keepalive interval (in seconds)
const STARTING_CLIENT_IP = 6; // Start assigning IPs from 10.0.0.6 (1=server, 2-5=preconfigured)

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

// Find next available IP
async function getNextAvailableIP() {
    const usedIPs = await getUsedIPs();
    
    for (let i = STARTING_CLIENT_IP; i < 255; i++) {
        const candidateIP = `10.0.0.${i}/32`;
        if (!usedIPs.includes(candidateIP)) {
            return candidateIP;
        }
    }
    
    throw new Error("No available IP addresses in the VPN network");
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

// Generate a new client configuration (like fly wireguard create)
app.post("/generate-client", async (req, res) => {
    try {
        console.log("🔐 Generating new WireGuard client...");
        
        // Generate client keys
        const { privateKey, publicKey } = await generateKeys();
        console.log(`✅ Generated keys for client`);
        
        // Get next available IP
        const allowedIPs = await getNextAvailableIP();
        console.log(`✅ Assigned IP: ${allowedIPs}`);
        
        // Add peer to WireGuard
        await runCommand(`wg set wg0 peer ${publicKey} allowed-ips ${allowedIPs} persistent-keepalive ${KEEPALIVE_TIME}`);
        console.log(`✅ Added peer to WireGuard`);
        
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
        res.setHeader('Content-Disposition', 'attachment; filename="wg0-client.conf"');
        
        // Send the config file directly
        res.send(clientConfig);
        
    } catch (error) {
        console.error("❌ Error generating client:", error);
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

// Health check endpoint
app.get("/", (req, res) => {
    res.json({ 
        status: "running",
        service: "WireGuard VPN Management API",
        endpoints: {
            "POST /generate-client": "Generate new WireGuard client configuration",
            "POST /add-peer": "Add peer manually with your own keys",
            "GET /list-peers": "List all connected peers"
        }
    });
});

// Run API on TCP Port 5000
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ WireGuard API running on port ${PORT}`));
