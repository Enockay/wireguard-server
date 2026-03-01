const Client = require("../models/Client");
const {
    wgLock,
    log,
    KEEPALIVE_TIME,
    validateKeepalive,
    runWgCommand,
    getServerPublicKey,
    getServerEndpoint
} = require("../wg-core");
const {
    generateKeys,
    getNextAvailableIP
} = require("../utils/route-helpers");
const { getTimeAgo } = require("../utils/route-helpers");

// Register all client management routes
function registerClientRoutes(app, getDbInitialized) {
    // Get all clients from database with filtering, pagination, and search
    app.get("/api/clients", async (req, res) => {
        try {
            const dbInitialized = getDbInitialized();
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
            // Try to find client by exact name match first
            let client = await Client.findOne({ name: name.toLowerCase() });
            
            // If not found, try to find by ID (in case name contains ID)
            if (!client && name.includes('-')) {
                const parts = name.split('-');
                const possibleId = parts[parts.length - 1];
                if (possibleId && possibleId.length === 24) {
                    // Looks like a MongoDB ObjectId, try finding by _id
                    try {
                        const mongoose = require('mongoose');
                        if (mongoose.Types.ObjectId.isValid(possibleId)) {
                            client = await Client.findById(possibleId);
                        }
                    } catch (e) {
                        // Ignore
                    }
                }
            }
            
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
            
            // Validate required fields
            if (!client.ip) {
                return res.status(400).json({
                    success: false,
                    message: `Client "${name}" has no IP address assigned`,
                    error: "NO_IP_ADDRESS"
                });
            }
            
            if (!client.privateKey) {
                return res.status(400).json({
                    success: false,
                    message: `Client "${name}" has no private key`,
                    error: "NO_PRIVATE_KEY"
                });
            }
            
            const ifaceName = (client.interfaceName || `wg-client-${client.name}`).replace(/[^a-zA-Z0-9_-]/g, '-');
            const allowed = "10.0.0.0/24";
            // Clean DNS: remove spaces after commas (MikroTik doesn't like "8.8.8.8, 1.1.1.1")
            const dns = (client.dns || "8.8.8.8,1.1.1.1").replace(/,\s+/g, ',').trim();
            const keepalive = validateKeepalive(client.persistentKeepalive);
            const serverWgIp = "10.0.0.1";
            
            // System user credentials for SSH monitoring
            // Use environment variable or generate a secure password (same for all routers)
            const systemUsername = process.env.MIKROTIK_SYSTEM_USERNAME ;
            let systemPassword = process.env.MIKROTIK_SYSTEM_PASSWORD;
            
            // If password not set, generate one and log it (admin should set it in env)
            if (!systemPassword) {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
                systemPassword = '';
                for (let i = 0; i < 24; i++) {
                    systemPassword += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                log('warn', 'system_password_generated', { 
                    message: 'MIKROTIK_SYSTEM_PASSWORD not set, generated random password. Set it in .env for consistency.',
                    username: systemUsername,
                    password: systemPassword
                });
            }
            
            // Escape values for MikroTik script (escape quotes and special chars properly)
            const escapeMikrotikValue = (value) => {
                if (value === null || value === undefined) return '';
                let str = String(value).trim();
                // Remove any existing quotes and problematic characters
                // Escape backslashes first
                str = str.replace(/\\/g, '\\\\');
                // Escape quotes by doubling them (MikroTik uses "" for literal quote)
                str = str.replace(/"/g, '""');
                // Remove newlines and carriage returns
                str = str.replace(/\r?\n/g, ' ');
                str = str.replace(/\r/g, ' ');
                // Remove any control characters
                str = str.replace(/[\x00-\x1F\x7F]/g, '');
                return str;
            };
            
            // Generate smart MikroTik auto-config script with connectivity check
            const autoconfigScript = `# WireGuard Auto-Configuration Script
# Generated: ${new Date().toISOString()}
# Client: ${escapeMikrotikValue(client.name)}

# Variables
:local IFACE "${escapeMikrotikValue(ifaceName)}"
:local CLIENTIPFULL "${escapeMikrotikValue(client.ip)}"
:local CLIENTIP "${escapeMikrotikValue(client.ip.split('/')[0])}"
:local SERVERPUBKEY "${escapeMikrotikValue(serverPublicKey)}"
:local SERVERHOST "${escapeMikrotikValue(serverHost)}"
:local SERVERPORT "${escapeMikrotikValue(serverPort)}"
:local ALLOWED "${escapeMikrotikValue(allowed)}"
:local DNSSERVERS "${escapeMikrotikValue(dns)}"
:local KEEPALIVE ${keepalive}
:local SERVERWGIP "${escapeMikrotikValue(serverWgIp)}"
:local CLIENTPRIVKEY "${escapeMikrotikValue(client.privateKey)}"
:local SYSUSER "${escapeMikrotikValue(systemUsername)}"
:local SYSPASS "${escapeMikrotikValue(systemPassword)}"

# If interface already exists, test connectivity first
:if ([/interface/wireguard/print count-only where name=$IFACE] > 0) do={
    :put "WireGuard interface $IFACE already exists, testing connectivity..."
    :local success 0
    :do {
        /ping $SERVERWGIP count=3 
        :set success 1
    } on-error={
        :set success 0
    }

    :if ($success = 1) do={
        :put "WireGuard for client already configured and working. No changes made."
        :return
    } else={
        :put "Existing WireGuard config not working. Reinstalling..."

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
/interface/wireguard/add name=$IFACE listen-port=51820 mtu=1420 private-key="$CLIENTPRIVKEY"

# Add peer configuration (server)
/interface/wireguard/peers/add interface=$IFACE public-key="$SERVERPUBKEY" endpoint-address=$SERVERHOST endpoint-port=$SERVERPORT allowed-address=$ALLOWED persistent-keepalive=$KEEPALIVE

# Assign IP address to interface
/ip/address/add address=$CLIENTIPFULL interface=$IFACE

# Configure DNS
/ip/dns/set servers=$DNSSERVERS

# Enable interface
/interface/wireguard/set $IFACE disabled=no

# Add routing if needed
/ip/route/add dst-address=$CLIENTIP gateway=$IFACE comment="WireGuard VPN Route"

# Create system user for SSH monitoring (if not exists)
:if ([/user/print count-only where name=$SYSUSER] = 0) do={
    /user/add name=$SYSUSER password=$SYSPASS group=read address=10.0.0.0/24
    :put "System user $SYSUSER created for monitoring"
} else={
    /user/set $SYSUSER password=$SYSPASS
    :put "System user $SYSUSER password updated"
}

# Enable SSH service if not enabled
/ip/service/enable ssh

# Ensure SSH is allowed from VPN network (only if rule doesn't exist)
:if ([/ip/firewall/filter/print count-only where chain=input protocol=tcp dst-port=22 src-address=10.0.0.0/24 comment~"Allow SSH from VPN network"] = 0) do={
    /ip/firewall/filter/add chain=input protocol=tcp dst-port=22 src-address=10.0.0.0/24 action=accept place-before=0 comment="Allow SSH from VPN network" disabled=no
}

# Test connectivity
:delay 2
:local success 0
:do {
    /ping $SERVERWGIP count=3 
    :set success 1
} on-error={
    :set success 0
}

# Success / fail message
:if ($success = 1) do={
    :put "WireGuard client configured successfully! Ping to $SERVERWGIP succeeded."
} else={
    :put "WireGuard client configured but ping to $SERVERWGIP failed. Check firewall/connectivity."
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

    // Ping remote server endpoint
    app.post("/api/clients/:name/ping", async (req, res) => {
        try {
            const { name } = req.params;
            const { target, count = 3 } = req.body;
            
            const client = await Client.findOne({ name: name.toLowerCase() });
            
            if (!client) {
                return res.status(404).json({
                    success: false,
                    message: `Client "${name}" not found`,
                    error: "CLIENT_NOT_FOUND"
                });
            }
            
            // Extract router IP from client IP (remove /32 if present)
            let routerIp = target;
            
            // If no target provided, try to get from client IP
            if (!routerIp) {
                if (!client.ip) {
                    return res.status(400).json({
                        success: false,
                        message: `Client "${name}" has no IP address assigned. Please provide a target IP.`,
                        error: "NO_IP_ADDRESS",
                        client: client.name
                    });
                }
                routerIp = client.ip.split('/')[0].trim();
            }
            
            // Validate router IP
            if (!routerIp || routerIp.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid target IP address",
                    error: "INVALID_IP",
                    client: client.name
                });
            }
            
            // Ping the router's VPN IP
            const { runCommand } = require("../wg-core");
            try {
                const pingResult = await runCommand(`ping -c ${count} -W 2 ${routerIp}`);
                res.json({
                    success: true,
                    message: `Ping to ${routerIp} successful`,
                    client: client.name,
                    target: routerIp,
                    result: pingResult
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: `Ping to ${routerIp} failed`,
                    client: client.name,
                    target: routerIp,
                    error: "PING_FAILED",
                    details: error.message
                });
            }
        } catch (error) {
            log('error', 'ping_error', { error: error.message });
            res.status(500).json({
                success: false,
                message: "Failed to ping router",
                error: "WIREGUARD_ERROR",
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
            const allocatedIp = await getNextAvailableIP(getDbInitialized());
            
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
}

module.exports = registerClientRoutes;
