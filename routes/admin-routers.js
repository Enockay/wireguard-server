const MikrotikRouter = require('../models/MikrotikRouter');
const User = require('../models/User');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const { executeRouterOSCommand } = require('../services/mikrotik-api-service');
const {
    ADMIN_ROUTER_PERMISSIONS,
    ROUTER_NOTE_CATEGORIES,
    ROUTER_FLAG_TYPES,
    ROUTER_FLAG_SEVERITIES,
    listAdminRouters,
    getAdminRouterStats,
    getAdminRouterDetail,
    getAdminRouterConnectivity,
    getAdminRouterPorts,
    getAdminRouterMonitoring,
    getAdminRouterActivity,
    getAdminRouterProvisioning,
    getAdminRouterDiagnostics,
    getAdminRouterNotes,
    getAdminRouterFlags,
    createRouterAdmin,
    generateRouterSetupArtifacts,
    disableRouter,
    reactivateRouter,
    resetRouterPeer,
    reprovisionRouter,
    reassignRouterPorts,
    markRouterProvisioningReviewed,
    deleteRouterAdmin
} = require('../services/admin-router-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function parseRouterKeyValueOutput(output) {
    const result = {};
    String(output || '')
        .split('\n')
        .map((line) => line.trim())
        .forEach((line) => {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (!match) return;
            const key = match[1].trim();
            const normalizedKey = key.replace(/\s+/g, '').replace(/-([a-z])/g, (_, character) => character.toUpperCase());
            result[normalizedKey.charAt(0).toLowerCase() + normalizedKey.slice(1)] = match[2].trim();
        });
    return result;
}

function parseSizeToBytes(value) {
    if (!value) return null;
    const match = String(value).trim().match(/^([\d.]+)\s*([kmgti]?i?b?)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (Number.isNaN(amount)) return null;
    const unit = (match[2] || '').toLowerCase();
    const multipliers = {
        '': 1,
        b: 1,
        k: 1024,
        kb: 1024,
        kib: 1024,
        m: 1024 ** 2,
        mb: 1024 ** 2,
        mib: 1024 ** 2,
        g: 1024 ** 3,
        gb: 1024 ** 3,
        gib: 1024 ** 3,
        t: 1024 ** 4,
        tb: 1024 ** 4,
        tib: 1024 ** 4,
    };
    return Math.round(amount * (multipliers[unit] || 1));
}

function parseCpuLoad(value) {
    if (!value) return null;
    const parsed = Number(String(value).replace(/[^\d.]/g, ''));
    return Number.isNaN(parsed) ? null : parsed;
}

function parsePingOutput(output) {
    const packetsSent = (String(output || '').match(/sent=(\d+)/i) || [])[1];
    const packetsReceived = (String(output || '').match(/received=(\d+)/i) || [])[1];
    const packetLoss = (String(output || '').match(/packet-loss=([\d.]+%?)/i) || [])[1];
    const avgRtt = (String(output || '').match(/avg-rtt=([\d.]+(?:ms)?)/i) || [])[1];

    const sent = packetsSent ? Number(packetsSent) : undefined;
    const received = packetsReceived ? Number(packetsReceived) : undefined;
    const parsedLoss = packetLoss ? Number(String(packetLoss).replace('%', '')) : undefined;
    const parsedRtt = avgRtt ? Number(String(avgRtt).replace(/ms/i, '')) : undefined;

    return {
        reachable: (received || 0) > 0,
        packetsSent: sent,
        packetsReceived: received,
        packetLoss: parsedLoss,
        avgRtt: parsedRtt
    };
}

function parseInterfacesOutput(output) {
    const interfaces = [];
    const lines = String(output || '').split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !/^\d+\s/.test(line)) continue;

        const typeMatch = line.match(/\btype="?([^"\s]+)"?/i);
        const nameMatch = line.match(/\bname="?([^"\s]+)"?/i);
        const disabledMatch = line.match(/\bdisabled=(yes|no|true|false)\b/i);
        const runningMatch = line.match(/\brunning=(yes|no|true|false)\b/i);
        const commentMatch = line.match(/\bcomment="?([^"]*)"?$/i);

        interfaces.push({
            name: nameMatch?.[1] || line.replace(/^\d+\s+/, '').split(/\s+/)[0] || 'unknown',
            type: typeMatch?.[1] || 'unknown',
            running: runningMatch ? ['yes', 'true'].includes(runningMatch[1].toLowerCase()) : /\bR\b/.test(line),
            disabled: disabledMatch ? ['yes', 'true'].includes(disabledMatch[1].toLowerCase()) : false,
            comment: commentMatch?.[1] || null
        });
    }
    return interfaces;
}

async function getRouterOr404(req, res) {
    const router = await MikrotikRouter.findById(req.params.id).populate('userId');
    if (!router) {
        res.status(404).json({ success: false, error: 'Router not found' });
        return null;
    }
    return router;
}

async function audit(req, router, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId: router.userId?._id || router.userId || null,
        targetRouterId: router._id,
        action,
        reason,
        metadata
    });
}

function registerAdminRouterRoutes(app) {
    app.get('/api/admin/routers/stats', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const stats = await getAdminRouterStats();
            res.json({ success: true, stats });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to load router stats', details: error.message });
        }
    });

    app.get('/api/admin/routers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const result = await listAdminRouters(req.query || {});
            if (result.format === 'csv') {
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', 'attachment; filename="admin-routers-export.csv"');
                return res.send(result.csv);
            }

            return res.json({ success: true, items: result.items, pagination: result.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load routers', details: error.message });
        }
    });

    app.post('/api/admin/routers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '').trim();
            const name = String(req.body?.name || '').trim();
            const serverNode = String(req.body?.serverNode || 'wireguard').trim() || 'wireguard';
            const reason = normalizeReason(req.body?.reason);

            if (!userId) {
                return res.status(400).json({ success: false, error: 'Customer user ID is required' });
            }
            if (!name) {
                return res.status(400).json({ success: false, error: 'Router name is required' });
            }

            const targetUser = await User.findById(userId).lean();
            if (!targetUser || targetUser.role !== 'user') {
                return res.status(404).json({ success: false, error: 'Target customer not found' });
            }

            const created = await createRouterAdmin({
                userId,
                name,
                serverNode,
                notes: reason || ''
            });

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: created.owner._id,
                targetRouterId: created.router._id,
                action: 'admin_create_router',
                reason,
                metadata: {
                    serverNode,
                    vpnIp: created.router.vpnIp,
                    ports: created.router.ports
                }
            });

            return res.status(201).json({
                success: true,
                data: {
                    id: String(created.router._id),
                    name: created.router.name,
                    vpnIp: created.router.vpnIp,
                    ports: created.router.ports,
                    status: created.router.status,
                    wireguardConfig: created.artifacts?.wireguardConfig
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create router', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const detail = await getAdminRouterDetail(req.params.id);
            if (!detail) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, data: detail });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router details', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/connectivity', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_CONNECTIVITY), async (req, res) => {
        try {
            const connectivity = await getAdminRouterConnectivity(req.params.id);
            if (!connectivity) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, connectivity });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router connectivity', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/ports', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const ports = await getAdminRouterPorts(req.params.id);
            if (!ports) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, ports });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router ports', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/monitoring', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_MONITORING), async (req, res) => {
        try {
            const monitoring = await getAdminRouterMonitoring(req.params.id);
            if (!monitoring) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, monitoring });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router monitoring', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/activity', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const activity = await getAdminRouterActivity(req.params.id, req.query || {});
            if (!activity) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: activity.items, pagination: activity.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router activity', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/provisioning', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const provisioning = await getAdminRouterProvisioning(req.params.id);
            if (!provisioning) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, provisioning });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router provisioning state', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/diagnostics', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const diagnostics = await getAdminRouterDiagnostics(req.params.id);
            if (!diagnostics) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, diagnostics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router diagnostics', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/notes', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const notes = await getAdminRouterNotes(req.params.id);
            if (!notes) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router notes', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/notes', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.ADD_NOTE), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !ROUTER_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid note category', categories: ROUTER_NOTE_CATEGORIES });
            }

            router.adminNotes.push({
                body: String(req.body.body).trim(),
                category: req.body.category || 'support',
                pinned: Boolean(req.body.pinned),
                author: req.adminUser.email
            });
            await router.save();
            await audit(req, router, 'admin.routers.add_note', normalizeReason(req.body.reason), {
                category: req.body.category || 'support',
                pinned: Boolean(req.body.pinned)
            });

            return res.json({ success: true, message: 'Router note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add router note', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/flags', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const flags = await getAdminRouterFlags(req.params.id);
            if (!flags) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: flags });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router flags', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/flags', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (!req.body?.flag) {
                return res.status(400).json({ success: false, error: 'Flag name is required' });
            }
            if (!ROUTER_FLAG_TYPES.includes(req.body.flag)) {
                return res.status(400).json({ success: false, error: 'Invalid flag type', flagTypes: ROUTER_FLAG_TYPES });
            }
            if (req.body.severity && !ROUTER_FLAG_SEVERITIES.includes(req.body.severity)) {
                return res.status(400).json({ success: false, error: 'Invalid flag severity', severities: ROUTER_FLAG_SEVERITIES });
            }

            router.internalFlags.push({
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || '',
                createdBy: req.adminUser.email
            });
            await router.save();
            await audit(req, router, 'admin.routers.add_flag', normalizeReason(req.body.reason), {
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || ''
            });

            return res.json({ success: true, message: 'Router flag added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add router flag', details: error.message });
        }
    });

    app.delete('/api/admin/routers/:id/flags/:flagId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const flag = router.internalFlags.id(req.params.flagId);
            if (!flag) {
                return res.status(404).json({ success: false, error: 'Flag not found' });
            }

            const removed = { flag: flag.flag, severity: flag.severity, description: flag.description };
            flag.deleteOne();
            await router.save();
            await audit(req, router, 'admin.routers.remove_flag', normalizeReason(req.body?.reason), removed);

            return res.json({ success: true, message: 'Router flag removed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove router flag', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/disable', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const bundle = await disableRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.disable', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router disabled successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to disable router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reactivate', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const bundle = await reactivateRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.reactivate', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router reactivated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reactivate router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reprovision', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REPROVISION), async (req, res) => {
        try {
            const bundle = await reprovisionRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.reprovision', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router reprovisioned successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reprovision router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/regenerate-setup', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REPROVISION), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const artifacts = await generateRouterSetupArtifacts(req.params.id);
            await audit(req, router, 'admin.routers.regenerate_setup', normalizeReason(req.body?.reason), { generatedAt: artifacts.generatedAt });
            return res.json({ success: true, message: 'Router setup regenerated successfully', artifacts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to regenerate router setup', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reset-peer', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.RESET_KEYS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const artifacts = await resetRouterPeer(req.params.id);
            await audit(req, router, 'admin.routers.reset_peer', normalizeReason(req.body?.reason), { generatedAt: artifacts.generatedAt });
            return res.json({ success: true, message: 'Router peer reset successfully', artifacts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reset router peer', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reassign-ports', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REASSIGN_PORTS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const result = await reassignRouterPorts(req.params.id, req.body?.ports || null);
            await audit(req, router, 'admin.routers.reassign_ports', normalizeReason(req.body?.reason), result);
            return res.json({ success: true, message: 'Router ports reassigned successfully', ...result });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reassign router ports', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/move-server', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MOVE_SERVER), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            return res.status(409).json({
                success: false,
                error: 'Router server moves are not supported in the current single-node WireGuard architecture',
                currentServerNode: router.serverNode || 'wireguard'
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to evaluate router server move', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/mark-reviewed', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const updated = await markRouterProvisioningReviewed(req.params.id, req.adminUser.email);
            await audit(req, router, 'admin.routers.mark_reviewed', normalizeReason(req.body?.reason), { reviewedAt: updated.provisioningReviewedAt });
            return res.json({ success: true, message: 'Router provisioning marked as reviewed', reviewedAt: updated.provisioningReviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark router as reviewed', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reboot', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (router.status !== 'active') {
                return res.status(400).json({ success: false, error: 'Router is not online' });
            }

            const result = await executeRouterOSCommand(router.vpnIp, '/system reboot');
            if (!result.success) {
                return res.status(500).json({ success: false, error: result.error || 'Failed to send reboot command' });
            }

            await audit(req, router, 'admin.routers.reboot', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Reboot command sent' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reboot router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/ping', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const result = await executeRouterOSCommand(router.vpnIp, '/ping 10.0.0.1 count=4');
            if (!result.success) {
                return res.json({ success: false, reachable: false, error: result.error || 'Ping failed' });
            }

            return res.json({ success: true, result: parsePingOutput(result.output) });
        } catch (error) {
            return res.status(500).json({ success: false, reachable: false, error: error.message });
        }
    });

    app.post('/api/admin/routers/:id/command', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.RUN_COMMAND), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const command = String(req.body?.command || '').trim();
            const reason = normalizeReason(req.body?.reason);
            if (!command) {
                return res.status(400).json({ success: false, error: 'Command is required' });
            }
            if (command.length > 500) {
                return res.status(400).json({ success: false, error: 'Command is too long' });
            }

            const result = await executeRouterOSCommand(router.vpnIp, command);
            await audit(req, router, 'admin.routers.run_command', reason, { command });

            if (!result.success) {
                return res.json({ success: false, error: result.error || 'Command execution failed' });
            }

            return res.json({ success: true, output: result.output || '' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to run router command', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/interfaces', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const result = await executeRouterOSCommand(router.vpnIp, '/interface print detail');
            if (!result.success) {
                return res.json({ success: false, error: result.error || 'Unable to load interfaces', interfaces: [] });
            }

            return res.json({ success: true, interfaces: parseInterfacesOutput(result.output) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message, interfaces: [] });
        }
    });

    app.get('/api/admin/routers/:id/live-health', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const result = await executeRouterOSCommand(router.vpnIp, '/system resource print');
            if (!result.success) {
                return res.json({
                    success: false,
                    health: {
                        uptime: null,
                        cpuLoad: null,
                        freeMemory: null,
                        totalMemory: null,
                        freeHddSpace: null,
                        boardName: null,
                        routerosVersion: null,
                        reachable: false,
                        error: result.error || 'Unable to fetch live health'
                    }
                });
            }

            const parsed = parseRouterKeyValueOutput(result.output);
            return res.json({
                success: true,
                health: {
                    uptime: parsed.uptime || null,
                    cpuLoad: parseCpuLoad(parsed.cpuLoad),
                    freeMemory: parseSizeToBytes(parsed.freeMemory),
                    totalMemory: parseSizeToBytes(parsed.totalMemory),
                    freeHddSpace: parseSizeToBytes(parsed.freeHddSpace),
                    boardName: parsed.boardName || null,
                    routerosVersion: parsed.version || null,
                    reachable: true
                }
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                health: {
                    uptime: null,
                    cpuLoad: null,
                    freeMemory: null,
                    totalMemory: null,
                    freeHddSpace: null,
                    boardName: null,
                    routerosVersion: null,
                    reachable: false,
                    error: error.message
                }
            });
        }
    });

    app.delete('/api/admin/routers/:id', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.DELETE), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const result = await deleteRouterAdmin(req.params.id);
            await audit(req, router, 'admin.routers.delete', normalizeReason(req.body?.reason), { routerName: router.name });
            return res.json({ success: true, message: 'Router deleted successfully', data: result });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete router', details: error.message });
        }
    });
}

module.exports = registerAdminRouterRoutes;
