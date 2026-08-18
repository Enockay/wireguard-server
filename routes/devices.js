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
const { generateKeys, getNextAvailableIP } = require("../utils/route-helpers");
const { authenticateToken } = require("./auth");

const DEVICE_TYPES = ['laptop', 'phone', 'desktop', 'other'];
const STALE_HANDSHAKE_SECONDS = 180; // matches the /api/health stale-peer threshold

function isOnline(client) {
    if (!client.lastHandshake) return false;
    return (Date.now() - new Date(client.lastHandshake).getTime()) / 1000 < STALE_HANDSHAKE_SECONDS;
}

function serializeDevice(client) {
    return {
        id: client._id,
        // client.name is the internal slug (e.g. "device-my-laptop-<userId>"),
        // kept unique/DNS-safe for the WireGuard interface; notes holds the
        // friendly name the user actually typed.
        name: client.notes || client.name,
        deviceType: client.deviceType,
        vpnIp: client.ip,
        enabled: client.enabled,
        online: isOnline(client),
        lastHandshake: client.lastHandshake,
        createdAt: client.createdAt
    };
}

// Customer-facing "My Devices" - a plain WireGuard peer for a personal device
// (laptop/phone/desktop), separate from the router-provisioning flow in
// mikrotik-routers.js. Same hub: once connected, a device can reach any other
// peer (including the user's MikroTik routers) at its VPN IP, because the
// server already forwards between wg0 peers and every client's default
// AllowedIPs covers the whole 10.0.0.0/24 subnet.
function registerDeviceRoutes(app, getDbInitialized) {
    app.get("/api/devices", authenticateToken, async (req, res) => {
        try {
            const devices = await Client.find({ createdBy: req.user.userId, deviceType: { $ne: 'router' } })
                .sort({ createdAt: -1 });
            res.json({ success: true, devices: devices.map(serializeDevice) });
        } catch (error) {
            log('error', 'list_devices_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to list devices", details: error.message });
        }
    });

    app.post("/api/devices", authenticateToken, async (req, res) => {
        try {
            const { name, deviceType = 'other' } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: "Device name is required" });
            }
            if (!DEVICE_TYPES.includes(deviceType)) {
                return res.status(400).json({ success: false, error: `deviceType must be one of: ${DEVICE_TYPES.join(', ')}` });
            }

            const { privateKey, publicKey } = await generateKeys();
            const allocatedIp = await getNextAvailableIP(getDbInitialized());
            const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

            const client = new Client({
                name: `device-${slug}-${req.user.userId}`,
                ip: allocatedIp,
                publicKey,
                privateKey,
                enabled: true,
                deviceType,
                notes: name.trim(),
                createdBy: req.user.userId
            });
            await client.save();

            const WG_ENABLED = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());
            if (WG_ENABLED) {
                try {
                    const keepalive = validateKeepalive(KEEPALIVE_TIME);
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allocatedIp, 'persistent-keepalive', String(keepalive)]));
                } catch (error) {
                    log('warn', 'device_peer_add_failed', { device: client.name, error: error.message });
                }
            }

            res.status(201).json({
                success: true,
                message: "Device added successfully",
                device: serializeDevice(client)
            });
        } catch (error) {
            log('error', 'create_device_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to add device", details: error.message });
        }
    });

    // WireGuard .conf for a device - only its owner can fetch it (unlike the
    // MikroTik autoconfig routes, a laptop/phone WireGuard app can send an
    // Authorization header, so this is safely kept behind auth).
    app.get("/api/devices/:id/config", authenticateToken, async (req, res) => {
        try {
            const client = await Client.findOne({ _id: req.params.id, createdBy: req.user.userId, deviceType: { $ne: 'router' } });
            if (!client) {
                return res.status(404).json({ success: false, error: "Device not found" });
            }

            const serverPublicKey = (await getServerPublicKey()).trim();
            const serverEndpoint = client.endpoint || getServerEndpoint();
            const dns = client.dns || "";
            const allowedIPs = client.allowedIPs || "10.0.0.0/24";
            const keepalive = validateKeepalive(client.persistentKeepalive);

            let config = `[Interface]\nPrivateKey = ${client.privateKey}\nAddress = ${client.ip}`;
            if (dns) config += `\nDNS = ${dns}`;
            config += `\n\n[Peer]\nPublicKey = ${serverPublicKey}\nEndpoint = ${serverEndpoint}\nAllowedIPs = ${allowedIPs}\nPersistentKeepalive = ${keepalive}`;

            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="${client.notes || client.name}.conf"`);
            res.send(config);
        } catch (error) {
            log('error', 'get_device_config_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to get device config", details: error.message });
        }
    });

    app.delete("/api/devices/:id", authenticateToken, async (req, res) => {
        try {
            const client = await Client.findOne({ _id: req.params.id, createdBy: req.user.userId, deviceType: { $ne: 'router' } });
            if (!client) {
                return res.status(404).json({ success: false, error: "Device not found" });
            }

            try {
                await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            } catch (error) {
                log('warn', 'device_peer_remove_failed', { device: client.name, error: error.message });
            }

            await client.deleteOne();
            res.json({ success: true, message: "Device removed successfully" });
        } catch (error) {
            log('error', 'delete_device_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to remove device", details: error.message });
        }
    });
}

module.exports = registerDeviceRoutes;
