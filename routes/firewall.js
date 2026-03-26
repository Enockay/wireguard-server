const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    listFilterRules,
    addFilterRule,
    updateFilterRule,
    deleteFilterRule,
    toggleFilterRule,
    listNatRules,
    addNatRule,
    updateNatRule,
    deleteNatRule,
    listAddressLists,
    addToAddressList,
    removeFromAddressList,
    blockSubscriber,
    unblockSubscriber
} = require('../services/firewall-service');

function resolveRouterFeatureError(error, notFoundMessage = 'Router not found') {
    const message = error?.message || 'Request failed';
    if (message === notFoundMessage) {
        return { status: 404, payload: { success: false, error: message } };
    }
    if (message === 'capability_missing' || error?.failureType === 'capability_missing') {
        return { status: 403, payload: { success: false, error: 'Router capability missing', code: 'capability_missing' } };
    }
    if (message === 'unsafe_operation_blocked' || error?.failureType === 'unsafe_operation_blocked') {
        return { status: 403, payload: { success: false, error: 'Operation blocked by router safety policy', code: 'unsafe_operation_blocked' } };
    }
    return { status: 500, payload: { success: false, error: message } };
}

function registerFirewallRoutes(app) {
    app.get('/api/admin/routers/:routerId/firewall/filter', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listFilterRules(req.params.routerId, String(req.query.chain || ''));
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/filter', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await addFilterRule(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.put('/api/admin/routers/:routerId/firewall/filter/:ruleId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await updateFilterRule(req.params.routerId, req.params.ruleId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/firewall/filter/:ruleId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await deleteFilterRule(req.params.routerId, req.params.ruleId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/filter/:ruleId/toggle', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await toggleFilterRule(req.params.routerId, req.params.ruleId, Boolean(req.body?.disabled));
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/firewall/nat', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listNatRules(req.params.routerId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/nat', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await addNatRule(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.put('/api/admin/routers/:routerId/firewall/nat/:ruleId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await updateNatRule(req.params.routerId, req.params.ruleId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/firewall/nat/:ruleId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await deleteNatRule(req.params.routerId, req.params.ruleId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/firewall/address-list', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listAddressLists(req.params.routerId, String(req.query.list || ''));
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/address-list', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await addToAddressList(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/firewall/address-list/:entryId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await removeFromAddressList(req.params.routerId, req.params.entryId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/block', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { ipAddress, reason = '' } = req.body || {};
            if (!ipAddress) {
                return res.status(400).json({ success: false, error: 'IP address is required' });
            }
            const data = await blockSubscriber(req.params.routerId, ipAddress, reason);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/firewall/unblock', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { ipAddress } = req.body || {};
            if (!ipAddress) {
                return res.status(400).json({ success: false, error: 'IP address is required' });
            }
            const data = await unblockSubscriber(req.params.routerId, ipAddress);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });
}

module.exports = registerFirewallRoutes;
