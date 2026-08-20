const MikrotikRouter = require("../models/MikrotikRouter");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");

// Admin-only endpoints for viewing MikroTik routers across all users
function registerAdminRouterRoutes(app, getDbInitialized) {
    // List all routers, across all users
    app.get("/api/admin/routers", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const {
                page = 1,
                limit = 50,
                status,
                search,
                sortBy = 'createdAt',
                sortOrder = 'desc'
            } = req.query;

            const query = {};
            if (status) {
                query.status = status;
            }

            let routerIds = null;
            if (search) {
                const User = require("../models/User");
                const matchingUsers = await User.find({
                    $or: [
                        { name: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } }
                    ]
                }).select('_id');
                const userIds = matchingUsers.map(u => u._id);

                query.$or = [
                    { name: { $regex: search, $options: 'i' } },
                    { userId: { $in: userIds } }
                ];
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

            const [routers, total] = await Promise.all([
                MikrotikRouter.find(query)
                    .populate('userId', 'name email')
                    .sort(sort)
                    .skip(skip)
                    .limit(parseInt(limit)),
                MikrotikRouter.countDocuments(query)
            ]);

            res.json({
                success: true,
                routers: routers.map(r => ({
                    id: r._id,
                    name: r.name,
                    owner: r.userId ? {
                        id: r.userId._id,
                        name: r.userId.name,
                        email: r.userId.email
                    } : null,
                    ports: r.ports,
                    status: r.status,
                    vpnIp: r.vpnIp,
                    lastSeen: r.lastSeen,
                    firstConnectedAt: r.firstConnectedAt,
                    createdAt: r.createdAt
                })),
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'admin_list_routers_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to list routers",
                details: error.message
            });
        }
    });

    // Get a single router, regardless of owner
    app.get("/api/admin/routers/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const Subscription = require("../models/Subscription");

            const router = await MikrotikRouter.findById(id)
                .populate('userId', 'name email')
                .populate('wireguardClientId');

            if (!router) {
                return res.status(404).json({
                    success: false,
                    error: "Router not found"
                });
            }

            const subscription = await Subscription.findOne({ routerId: router._id });

            res.json({
                success: true,
                router: {
                    id: router._id,
                    name: router.name,
                    owner: router.userId ? {
                        id: router.userId._id,
                        name: router.userId.name,
                        email: router.userId.email
                    } : null,
                    ports: router.ports,
                    status: router.status,
                    vpnIp: router.vpnIp,
                    wireguardConfig: router.wireguardClientId ? {
                        publicKey: router.wireguardClientId.publicKey,
                        ip: router.wireguardClientId.ip,
                        clientName: router.wireguardClientId.name,
                        enabled: router.wireguardClientId.enabled
                    } : null,
                    routerboardInfo: router.routerboardInfo || null,
                    lastSeen: router.lastSeen,
                    firstConnectedAt: router.firstConnectedAt,
                    createdAt: router.createdAt,
                    subscription: subscription ? {
                        status: subscription.status,
                        planType: subscription.planType,
                        pricePerMonth: subscription.pricePerMonth,
                        currentPeriodEnd: subscription.currentPeriodEnd,
                        nextBillingDate: subscription.nextBillingDate
                    } : null
                }
            });
        } catch (error) {
            log('error', 'admin_get_router_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to get router",
                details: error.message
            });
        }
    });

    // On-demand fetch of routerboard info (Model/Uptime/CPU/Firmware/Serial)
    // over SSH, rather than waiting up to 5 minutes for the periodic
    // background job (wireguard-api.js:checkRouterStatus).
    app.post("/api/admin/routers/:id/refresh-info", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const router = await MikrotikRouter.findById(id).populate('wireguardClientId');
            if (!router) {
                return res.status(404).json({ success: false, error: "Router not found" });
            }
            if (!router.wireguardClientId) {
                return res.status(400).json({ success: false, error: "Router has no linked WireGuard client" });
            }

            const { resolveInterfaceName } = require("../wg-core");
            const { getRouterboardInfoSSH } = require("../services/mikrotik-api-service");
            const { getConfig } = require("../config-cache");
            const { updateRouterStatus } = require("./mikrotik-routers");

            const vpnIp = router.wireguardClientId.ip.split('/')[0];
            const username = getConfig('mikrotikSystemUsername') || process.env.MIKROTIK_SYSTEM_USERNAME || 'wgmonitor';
            const password = getConfig('mikrotikSystemPassword') || process.env.MIKROTIK_SYSTEM_PASSWORD || '';

            const info = await getRouterboardInfoSSH(vpnIp, username, password, resolveInterfaceName(router.wireguardClientId));
            await updateRouterStatus(router._id, !!info.reachable, info);

            if (!info.success) {
                return res.status(502).json({
                    success: false,
                    error: "Could not reach router over SSH",
                    details: info.error || null
                });
            }

            res.json({ success: true, routerboardInfo: (await MikrotikRouter.findById(id)).routerboardInfo });
        } catch (error) {
            log('error', 'admin_refresh_router_info_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to refresh routerboard info",
                details: error.message
            });
        }
    });

    // Force-restart a router's TCP proxy (Winbox/SSH/API port forwarding)
    app.post("/api/admin/routers/:id/reconnect", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const router = await MikrotikRouter.findById(id);
            if (!router) {
                return res.status(404).json({ success: false, error: "Router not found" });
            }

            const { restartRouterProxy } = require("../services/tcp-proxy-service");
            await restartRouterProxy(id);

            res.json({ success: true, message: "Router proxy restarted" });
        } catch (error) {
            log('error', 'admin_reconnect_router_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: "Failed to restart router proxy",
                details: error.message
            });
        }
    });
}

module.exports = registerAdminRouterRoutes;
