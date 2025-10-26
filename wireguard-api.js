const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");

const app = express();
app.use(bodyParser.json());

const KEEPALIVE_TIME = 25; // Keepalive interval (in seconds)

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

// Add a new peer to WireGuard
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

// Run API on TCP Port 5000
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ WireGuard API running on port ${PORT}`));
