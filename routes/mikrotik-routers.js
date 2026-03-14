const MikrotikRouter = require('../models/MikrotikRouter');
const User = require('../models/User');
const Client = require('../models/Client');
const { allocatePorts, releasePorts } = require('../utils/port-allocator');
const { generateKeys, getNextAvailableIP } = require('../utils/route-helpers');
const { authenticateToken } = require('./auth');
const { log } = require('../wg-core');
const { sendRouterCreatedEmail, sendRouterOnlineEmail } = require('../services/email-service');
const { createSubscription, getUserBillingSummary } = require('../services/billing-service');
const { wgLock, runWgCommand, KEEPALIVE_TIME, validateKeepalive } = require('../wg-core');
const { startRouterProxy } = require('../services/tcp-proxy-service');

function registerMikrotikRouterRoutes(app, getDbInitialized) {
    // Create new MikroTik router (requires auth)
    app.post('/api/routers', authenticateToken, async (req, res) => {
        try {
            const { name, notes } = req.body;
            const userId = req.user.userId;

            if (!name) {
                return res.status(400).json({
                    success: false,
                    error: 'Router name is required'
                });
            }

            // Get user to check trial status
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            // Check if user has verified email
            if (!user.emailVerified) {
                return res.status(403).json({
                    success: false,
                    error: 'Please verify your email before creating routers'
                });
            }

            // Allocate ports
            const ports = await allocatePorts();

            // Create WireGuard client for this router
            const { privateKey, publicKey } = await generateKeys();
            const allocatedIp = await getNextAvailableIP(getDbInitialized());

            const wireguardClient = new Client({
                name: `router-${name.toLowerCase()}-${userId}`,
                ip: allocatedIp,
                publicKey,
                privateKey,
                enabled: true,
                notes: `MikroTik router: ${name}`,
                createdBy: userId.toString()
            });

            await wireguardClient.save();

            // Add to WireGuard if enabled
            const WG_ENABLED = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());
            if (WG_ENABLED) {
                try {
                    const keepalive = validateKeepalive(KEEPALIVE_TIME);
                    await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', publicKey, 'allowed-ips', allocatedIp, 'persistent-keepalive', String(keepalive)]));
                    log('info', 'peer_added', { client: wireguardClient.name });
                } catch (error) {
                    log('warn', 'peer_add_failed', { client: wireguardClient.name, error: error.message });
                }
            }

            // Create MikroTik router record
            const router = new MikrotikRouter({
                userId,
                name,
                wireguardClientId: wireguardClient._id,
                vpnIp: allocatedIp,
                ports,
                status: 'pending',
                lastSetupGeneratedAt: new Date(),
                lastReconfiguredAt: new Date(),
                notes: notes || ''
            });

            await router.save();

            // Create subscription for this router (handles trial and balance deduction)
            const subscription = await createSubscription(userId, router._id);

            // Start TCP proxy for this router
            try {
                await startRouterProxy(router._id);
                log('info', 'router_proxy_started_on_create', { routerId: router._id });
            } catch (proxyError) {
                log('error', 'router_proxy_start_failed', { 
                    routerId: router._id, 
                    error: proxyError.message 
                });
                // Don't fail router creation if proxy fails - it can be started later
            }

            // Send email notification
            try {
                await sendRouterCreatedEmail(user, {
                    name: router.name,
                    vpnIp: router.vpnIp,
                    ports: router.ports,
                    status: router.status
                });
                log('info', 'router_created_email_sent', { userId, routerId: router._id });
            } catch (emailError) {
                log('error', 'router_created_email_failed', { 
                    userId, 
                    routerId: router._id,
                    error: emailError.message 
                });
                // Don't fail router creation if email fails
            }

            res.status(201).json({
                success: true,
                message: 'MikroTik router created successfully',
                data: {
                    router: {
                        id: router._id,
                        name: router.name,
                        ports: router.ports,
                        status: router.status,
                        publicUrl: {
                            winbox: `vpn.blackie-networks.com:${router.ports.winbox}`,
                            ssh: `vpn.blackie-networks.com:${router.ports.ssh}`,
                            api: `vpn.blackie-networks.com:${router.ports.api}`
                        },
                        wireguardConfig: {
                            privateKey: wireguardClient.privateKey,
                            publicKey: wireguardClient.publicKey,
                            ip: wireguardClient.ip
                        },
                        subscription: {
                            status: subscription.status,
                            planType: subscription.planType,
                            pricePerMonth: subscription.pricePerMonth,
                            nextBillingDate: subscription.nextBillingDate
                        }
                    }
                }
            });
        } catch (error) {
            log('error', 'create_router_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to create router',
                details: error.message
            });
        }
    });

    // Get user's routers
    app.get('/api/routers', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const Subscription = require('../models/Subscription');

            const routers = await MikrotikRouter.find({ userId })
                .populate('wireguardClientId')
                .sort({ createdAt: -1 });

            // Get subscriptions for all routers
            const routerIds = routers.map(r => r._id);
            const subscriptions = await Subscription.find({ routerId: { $in: routerIds } });
            const subscriptionMap = new Map(subscriptions.map(s => [s.routerId.toString(), s]));

            res.json({
                success: true,
                routers: routers.map((r, index) => {
                    const subscription = subscriptionMap.get(r._id.toString());
                    return {
                        id: r._id,
                        name: r.name,
                        ports: r.ports,
                        status: r.status,
                        publicUrl: {
                            winbox: `vpn.blackie-networks.com:${r.ports.winbox}`,
                            ssh: `vpn.blackie-networks.com:${r.ports.ssh}`,
                            api: `vpn.blackie-networks.com:${r.ports.api}`
                        },
                        address: 'vpn.blackie-networks.com',
                        expirationDate: subscription?.currentPeriodEnd || subscription?.nextBillingDate || null,
                        subscriptionStatus: subscription?.status || 'trial',
                        lastSeen: r.lastSeen,
                        firstConnectedAt: r.firstConnectedAt,
                        createdAt: r.createdAt,
                        isOnline: r.status === 'active',
                        routerboardInfo: r.routerboardInfo || null,
                        wireguardConfig: r.wireguardClientId ? {
                            clientName: r.wireguardClientId.name
                        } : null
                    };
                })
            });
        } catch (error) {
            log('error', 'list_routers_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to list routers',
                details: error.message
            });
        }
    });

    // Get single router
    app.get('/api/routers/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const userId = req.user.userId;

            const router = await MikrotikRouter.findOne({ _id: id, userId })
                .populate('wireguardClientId');

            if (!router) {
                return res.status(404).json({
                    success: false,
                    error: 'Router not found'
                });
            }

            res.json({
                success: true,
                router: {
                    id: router._id,
                    name: router.name,
                    ports: router.ports,
                    status: router.status,
                    publicUrl: {
                        winbox: `vpn.blackie-networks.com:${router.ports.winbox}`,
                        ssh: `vpn.blackie-networks.com:${router.ports.ssh}`,
                        api: `vpn.blackie-networks.com:${router.ports.api}`
                    },
                    wireguardConfig: router.wireguardClientId ? {
                        privateKey: router.wireguardClientId.privateKey,
                        publicKey: router.wireguardClientId.publicKey,
                        ip: router.wireguardClientId.ip,
                        clientName: router.wireguardClientId.name
                    } : null,
                    routerboardInfo: router.routerboardInfo || null,
                    lastSeen: router.lastSeen,
                    firstConnectedAt: router.firstConnectedAt,
                    createdAt: router.createdAt
                }
            });
        } catch (error) {
            log('error', 'get_router_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get router',
                details: error.message
            });
        }
    });

    // Delete router
    app.delete('/api/routers/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const userId = req.user.userId;

            const router = await MikrotikRouter.findOne({ _id: id, userId })
                .populate('userId');
            if (!router) {
                return res.status(404).json({
                    success: false,
                    error: 'Router not found'
                });
            }

            // Store router info for email before deletion
            const routerInfo = {
                name: router.name,
                ports: router.ports
            };

            // Delete WireGuard client
            await Client.findByIdAndDelete(router.wireguardClientId);

            // Stop TCP proxy
            const { stopRouterProxy } = require('../services/tcp-proxy-service');
            stopRouterProxy(router._id);

            // Release ports (for logging)
            await releasePorts(router._id);

            // Delete router (subscription will be handled separately if needed)
            await router.deleteOne();

            // Send deletion email notification
            if (router.userId) {
                try {
                    const { sendRouterDeletedEmail } = require('../services/email-service');
                    await sendRouterDeletedEmail(router.userId, routerInfo);
                    log('info', 'router_deleted_email_sent', { userId, routerId: id });
                } catch (emailError) {
                    log('error', 'router_deleted_email_failed', { 
                        userId, 
                        routerId: id,
                        error: emailError.message 
                    });
                    // Don't fail deletion if email fails
                }
            }

            res.json({
                success: true,
                message: 'Router deleted successfully'
            });
        } catch (error) {
            log('error', 'delete_router_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to delete router',
                details: error.message
            });
        }
    });

    // Get billing summary
    app.get('/api/routers/billing/summary', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const summary = await getUserBillingSummary(userId);

            res.json({
                success: true,
                billing: summary
            });
        } catch (error) {
            log('error', 'get_billing_summary_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get billing summary',
                details: error.message
            });
        }
    });
}

// Function to update router status when it comes online
async function updateRouterStatus(routerId, isOnline, routerboardInfo = null) {
    try {
        const router = await MikrotikRouter.findById(routerId).populate('userId');
        if (!router) return;

        const wasOffline = router.status !== 'active';
        const now = new Date();

        if (isOnline) {
            router.status = 'active';
            router.lastSeen = now;
            if (!router.firstConnectedAt) {
                router.firstConnectedAt = now;
            }

            // Store routerboard information if available
            if (routerboardInfo && routerboardInfo.success) {
                router.routerboardInfo = {
                    uptime: routerboardInfo.uptime || null,
                    cpuLoad: routerboardInfo.cpuLoad || null,
                    memoryUsage: routerboardInfo.memoryUsage || null,
                    totalMemory: routerboardInfo.totalMemory || null,
                    freeMemory: routerboardInfo.freeMemory || null,
                    boardName: routerboardInfo.boardName || null,
                    model: routerboardInfo.model || null,
                    serialNumber: routerboardInfo.serialNumber || null,
                    firmware: routerboardInfo.firmware || null,
                    lastChecked: now
                };
            }

            // Ensure TCP proxy is running
            const { getProxyStatus, startRouterProxy } = require('../services/tcp-proxy-service');
            const proxyStatus = getProxyStatus(routerId);
            if (!proxyStatus.running) {
                try {
                    await startRouterProxy(routerId);
                    log('info', 'proxy_started_on_router_online', { routerId });
                } catch (proxyError) {
                    log('error', 'proxy_start_failed_on_online', { 
                        routerId, 
                        error: proxyError.message 
                    });
                }
            }

            // Send email if router just came online
            if (wasOffline && router.userId) {
                try {
                    await sendRouterOnlineEmail(router.userId, {
                        name: router.name,
                        vpnIp: router.vpnIp,
                        ports: router.ports,
                        status: router.status,
                        lastSeen: router.lastSeen,
                        routerboardInfo: router.routerboardInfo
                    });
                    log('info', 'router_online_email_sent', { routerId, userId: router.userId._id });
                } catch (emailError) {
                    log('error', 'router_online_email_failed', { 
                        routerId, 
                        error: emailError.message 
                    });
                }
            }
        } else {
            router.status = 'offline';
            // Keep routerboard info but mark last checked
            if (router.routerboardInfo) {
                router.routerboardInfo.lastChecked = now;
            }
        }

        await router.save();
    } catch (error) {
        log('error', 'update_router_status_error', { routerId, error: error.message });
    }
}

module.exports = { registerMikrotikRouterRoutes, updateRouterStatus };
