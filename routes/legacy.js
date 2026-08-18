const Client = require("../models/Client");
const {
    wgLock,
    log,
    KEEPALIVE_TIME,
    validateKeepalive,
    runWgCommand,
    runCommand,
    getServerPublicKey,
    getServerEndpoint
} = require("../wg-core");
const {
    generateKeys,
    getNextAvailableIP,
    loadClientsFromDatabase
} = require("../utils/route-helpers");

// Register all legacy routes for backward compatibility
function registerLegacyRoutes(app, getDbInitialized) {
    // Generate a new client configuration (legacy)
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
            const allowedIPs = await getNextAvailableIP(getDbInitialized());
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

    // Get all connected peers (legacy)
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

    // Add peer manually (legacy)
    app.post("/add-peer", async (req, res) => {
        try {
            const { publicKey, allowedIPs, persistentKeepalive } = req.body;
            
            if (!publicKey || !allowedIPs) {
                return res.status(400).json({
                    success: false,
                    error: "publicKey and allowedIPs are required"
                });
            }
            
            const keepalive = validateKeepalive(persistentKeepalive || KEEPALIVE_TIME);
            await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allowedIPs, 'persistent-keepalive', String(keepalive)]));
            
            res.json({
                success: true,
                message: "Peer added successfully"
            });
        } catch (error) {
            log('error', 'add_peer_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to add peer",
                details: error.message
            });
        }
    });

    // Legacy endpoint for backward compatibility - List clients
    app.get("/clients", async (req, res) => {
        try {
            const dbInitialized = getDbInitialized();
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

    // Legacy endpoint for backward compatibility - Get client config
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

    // Delete client (legacy)
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
}

module.exports = registerLegacyRoutes;
