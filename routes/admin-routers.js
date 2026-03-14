const MikrotikRouter = require('../models/MikrotikRouter');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
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
