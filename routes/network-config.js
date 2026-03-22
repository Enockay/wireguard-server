const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    listDhcpLeases,
    makeStaticLease,
    deleteLease,
    listWirelessClients,
    listInterfaces,
    setInterfaceEnabled
} = require('../services/network-config-service');

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

function registerNetworkConfigRoutes(app) {
    app.get('/api/admin/routers/:routerId/network/dhcp-leases', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listDhcpLeases(req.params.routerId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/network/dhcp-leases/:routerosId/make-static', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await makeStaticLease(req.params.routerId, req.params.routerosId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/network/dhcp-leases/:routerosId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await deleteLease(req.params.routerId, req.params.routerosId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/network/wireless-clients', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listWirelessClients(req.params.routerId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/network/interfaces', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listInterfaces(req.params.routerId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/network/interfaces/:name/enable', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await setInterfaceEnabled(req.params.routerId, req.params.name, true);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/network/interfaces/:name/disable', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await setInterfaceEnabled(req.params.routerId, req.params.name, false);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });
}

module.exports = registerNetworkConfigRoutes;
