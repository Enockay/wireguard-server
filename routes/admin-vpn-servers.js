const VpnServer = require('../models/VpnServer');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const {
    ADMIN_VPN_SERVER_PERMISSIONS,
    VPN_SERVER_NOTE_CATEGORIES,
    VPN_SERVER_FLAG_TYPES,
    VPN_SERVER_FLAG_SEVERITIES,
    listAdminVpnServers,
    getAdminVpnServerStats,
    getAdminVpnServerDetail,
    getAdminVpnServerHealth,
    getAdminVpnServerRouters,
    getAdminVpnServerPeers,
    getAdminVpnServerTraffic,
    getAdminVpnServerActivity,
    getAdminVpnServerDiagnostics,
    getAdminVpnServerNotes,
    getAdminVpnServerFlags,
    addVpnServer,
    disableVpnServer,
    reactivateVpnServer,
    setVpnServerMaintenance,
    restartVpnServer,
    reconcileVpnServer,
    markVpnServerReviewed,
    migrateRoutersBetweenServers
} = require('../services/admin-vpn-server-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

async function getServerOr404(req, res) {
    const server = await VpnServer.findById(req.params.id);
    if (!server) {
        res.status(404).json({ success: false, error: 'VPN server not found' });
        return null;
    }
    return server;
}

async function audit(req, server, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetServerId: server._id,
        action,
        reason,
        metadata
    });
}

function registerAdminVpnServerRoutes(app) {
    app.get('/api/admin/vpn-servers/stats', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const stats = await getAdminVpnServerStats();
            res.json({ success: true, stats });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to load VPN server stats', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const data = await listAdminVpnServers(req.query || {});
            res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to load VPN servers', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.ADD), async (req, res) => {
        try {
            if (!req.body?.nodeId || !req.body?.name) {
                return res.status(400).json({ success: false, error: 'nodeId and name are required' });
            }
            const server = await addVpnServer(req.body);
            await audit(req, server, 'admin.vpn_servers.add', normalizeReason(req.body.reason), {
                nodeId: server.nodeId,
                controlMode: server.controlMode
            });
            return res.status(201).json({ success: true, message: 'VPN server added successfully', server });
        } catch (error) {
            if (error.code === 11000) {
                return res.status(409).json({ success: false, error: 'VPN server with this nodeId already exists' });
            }
            return res.status(500).json({ success: false, error: 'Failed to add VPN server', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const detail = await getAdminVpnServerDetail(req.params.id);
            if (!detail) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, data: detail });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server detail', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/health', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_HEALTH), async (req, res) => {
        try {
            const health = await getAdminVpnServerHealth(req.params.id);
            if (!health) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, health });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server health', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/routers', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const routers = await getAdminVpnServerRouters(req.params.id, req.query || {});
            if (!routers) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, items: routers.items, pagination: routers.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server routers', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/peers', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_PEERS), async (req, res) => {
        try {
            const peers = await getAdminVpnServerPeers(req.params.id, req.query || {});
            if (!peers) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, items: peers.items, pagination: peers.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server peers', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/traffic', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_HEALTH), async (req, res) => {
        try {
            const traffic = await getAdminVpnServerTraffic(req.params.id);
            if (!traffic) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, traffic });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server traffic', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/activity', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const activity = await getAdminVpnServerActivity(req.params.id, req.query || {});
            if (!activity) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, items: activity.items, pagination: activity.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server activity', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/diagnostics', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const diagnostics = await getAdminVpnServerDiagnostics(req.params.id);
            if (!diagnostics) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, diagnostics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server diagnostics', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/notes', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const notes = await getAdminVpnServerNotes(req.params.id);
            if (!notes) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server notes', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/notes', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.ADD_NOTE), async (req, res) => {
        try {
            const server = await getServerOr404(req, res);
            if (!server) return;
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !VPN_SERVER_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid note category', categories: VPN_SERVER_NOTE_CATEGORIES });
            }
            server.adminNotes.push({
                body: String(req.body.body).trim(),
                category: req.body.category || 'infrastructure',
                pinned: Boolean(req.body.pinned),
                author: req.adminUser.email
            });
            await server.save();
            await audit(req, server, 'admin.vpn_servers.add_note', normalizeReason(req.body.reason), {
                category: req.body.category || 'infrastructure',
                pinned: Boolean(req.body.pinned)
            });
            return res.json({ success: true, message: 'VPN server note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add VPN server note', details: error.message });
        }
    });

    app.get('/api/admin/vpn-servers/:id/flags', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const flags = await getAdminVpnServerFlags(req.params.id);
            if (!flags) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            return res.json({ success: true, items: flags });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server flags', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/flags', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const server = await getServerOr404(req, res);
            if (!server) return;
            if (!req.body?.flag) {
                return res.status(400).json({ success: false, error: 'Flag name is required' });
            }
            if (!VPN_SERVER_FLAG_TYPES.includes(req.body.flag)) {
                return res.status(400).json({ success: false, error: 'Invalid flag type', flagTypes: VPN_SERVER_FLAG_TYPES });
            }
            if (req.body.severity && !VPN_SERVER_FLAG_SEVERITIES.includes(req.body.severity)) {
                return res.status(400).json({ success: false, error: 'Invalid flag severity', severities: VPN_SERVER_FLAG_SEVERITIES });
            }
            server.internalFlags.push({
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || '',
                createdBy: req.adminUser.email
            });
            await server.save();
            await audit(req, server, 'admin.vpn_servers.add_flag', normalizeReason(req.body.reason), {
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || ''
            });
            return res.json({ success: true, message: 'VPN server flag added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add VPN server flag', details: error.message });
        }
    });

    app.delete('/api/admin/vpn-servers/:id/flags/:flagId', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const server = await getServerOr404(req, res);
            if (!server) return;
            const flag = server.internalFlags.id(req.params.flagId);
            if (!flag) {
                return res.status(404).json({ success: false, error: 'Flag not found' });
            }
            const removed = { flag: flag.flag, severity: flag.severity, description: flag.description };
            flag.deleteOne();
            await server.save();
            await audit(req, server, 'admin.vpn_servers.remove_flag', normalizeReason(req.body?.reason), removed);
            return res.json({ success: true, message: 'VPN server flag removed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove VPN server flag', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/disable', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.DISABLE), async (req, res) => {
        try {
            const server = await disableVpnServer(req.params.id);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.disable', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'VPN server disabled successfully' });
        } catch (error) {
            if (error.code === 'SERVER_HAS_ACTIVE_ASSIGNMENTS') {
                return res.status(409).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, error: 'Failed to disable VPN server', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/reactivate', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const server = await reactivateVpnServer(req.params.id);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.reactivate', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'VPN server reactivated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reactivate VPN server', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/maintenance', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MAINTENANCE), async (req, res) => {
        try {
            const server = await setVpnServerMaintenance(req.params.id, true);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.maintenance_on', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'VPN server entered maintenance mode' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to enable maintenance mode', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/maintenance/clear', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MAINTENANCE), async (req, res) => {
        try {
            const server = await setVpnServerMaintenance(req.params.id, false);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.maintenance_clear', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'VPN server maintenance mode cleared' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to clear maintenance mode', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/migrate-routers', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MIGRATE_ROUTERS), async (req, res) => {
        try {
            const source = await getServerOr404(req, res);
            if (!source) return;
            if (!req.body?.targetServerId) {
                return res.status(400).json({ success: false, error: 'targetServerId is required' });
            }
            const result = await migrateRoutersBetweenServers(req.params.id, req.body.targetServerId, req.body.routerIds || []);
            await audit(req, source, 'admin.vpn_servers.migrate_routers', normalizeReason(req.body?.reason), result);
            return res.status(result.routersMigrated.length ? 200 : 409).json({ success: result.routersMigrated.length > 0, migration: result });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to migrate routers', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/restart-vpn', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.RESTART_VPN), async (req, res) => {
        try {
            const server = await restartVpnServer(req.params.id);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.restart_vpn', normalizeReason(req.body?.reason), { lastRestartAt: server.lastRestartAt });
            return res.json({ success: true, message: 'VPN restart completed successfully', lastRestartAt: server.lastRestartAt });
        } catch (error) {
            if (error.code === 'UNSUPPORTED_CONTROL_MODE') {
                return res.status(409).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, error: 'Failed to restart VPN service', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/reconcile', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const server = await reconcileVpnServer(req.params.id);
            if (!server) {
                return res.status(404).json({ success: false, error: 'VPN server not found' });
            }
            await audit(req, server, 'admin.vpn_servers.reconcile', normalizeReason(req.body?.reason), { lastReconcileAt: server.lastReconcileAt });
            return res.json({ success: true, message: 'VPN peer reconciliation completed', lastReconcileAt: server.lastReconcileAt });
        } catch (error) {
            if (error.code === 'UNSUPPORTED_CONTROL_MODE') {
                return res.status(409).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, error: 'Failed to reconcile VPN peers', details: error.message });
        }
    });

    app.post('/api/admin/vpn-servers/:id/mark-reviewed', requireAdminPermission(ADMIN_VPN_SERVER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const server = await getServerOr404(req, res);
            if (!server) return;
            const updated = await markVpnServerReviewed(req.params.id, req.adminUser.email);
            await audit(req, server, 'admin.vpn_servers.mark_reviewed', normalizeReason(req.body?.reason), { reviewedAt: updated.reviewedAt });
            return res.json({ success: true, message: 'VPN server issue marked as reviewed', reviewedAt: updated.reviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark VPN server as reviewed', details: error.message });
        }
    });
}

module.exports = registerAdminVpnServerRoutes;
