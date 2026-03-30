const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    listHotspotUsers,
    getHotspotUserDetail,
    createHotspotUser,
    updateHotspotUser,
    deleteHotspotUser,
    listActiveSessions,
    disconnectSession,
    generateVouchers,
    listProfiles,
    createProfile,
    updateProfile,
    listVouchers,
    revokeVoucher
} = require('../services/hotspot-service');

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

function registerHotspotRoutes(app) {
    app.get('/api/admin/routers/:routerId/hotspot/users', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const { routerId } = req.params;
            const { page = 1, limit = 50, search = '' } = req.query;
            const result = await listHotspotUsers(routerId, page, limit, search);
            return res.json({ success: true, data: result.items, pagination: result.pagination });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/hotspot/users', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { routerId } = req.params;
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ success: false, error: 'Username and password are required' });
            }
            const data = await createHotspotUser(routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/hotspot/users/:userId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getHotspotUserDetail(req.params.routerId, req.params.userId);
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(error.message === 'Hotspot user not found' ? 404 : 500).json({ success: false, error: error.message || 'Failed to load hotspot user' });
        }
    });

    app.put('/api/admin/routers/:routerId/hotspot/users/:userId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const detail = await getHotspotUserDetail(req.params.routerId, req.params.userId);
            const data = await updateHotspotUser(req.params.routerId, detail.routerosId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Hotspot user not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/hotspot/users/:userId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const detail = await getHotspotUserDetail(req.params.routerId, req.params.userId);
            const data = await deleteHotspotUser(req.params.routerId, detail.routerosId, req.params.userId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Hotspot user not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/hotspot/vouchers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await generateVouchers(req.params.routerId, {
                ...(req.body || {}),
                createdBy: req.adminUser?.email || 'admin'
            });
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/hotspot/vouchers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const result = await listVouchers(req.params.routerId, req.query || {});
            return res.json({
                success: true,
                vouchers: result.items,
                total: result.pagination.total,
                page: result.pagination.page,
                limit: result.pagination.limit
            });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/hotspot/vouchers/:voucherId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            await revokeVoucher(req.params.routerId, req.params.voucherId);
            return res.json({ success: true });
        } catch (error) {
            if (error.statusCode === 409) {
                return res.status(409).json({ success: false, error: error.message });
            }
            const resolved = error.message === 'Voucher not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/hotspot/sessions', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_MONITORING), async (req, res) => {
        try {
            const data = await listActiveSessions(req.params.routerId);
            return res.json({ success: true, data, pagination: { page: 1, limit: data.length, total: data.length, pages: 1 } });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/hotspot/sessions/:sessionId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await disconnectSession(req.params.routerId, req.params.sessionId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/hotspot/profiles', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listProfiles(req.params.routerId);
            return res.json({ success: true, data, pagination: { page: 1, limit: data.length, total: data.length, pages: 1 } });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/hotspot/profiles', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { name } = req.body || {};
            if (!name) {
                return res.status(400).json({ success: false, error: 'Profile name is required' });
            }
            const data = await createProfile(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.put('/api/admin/routers/:routerId/hotspot/profiles/:profileId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await updateProfile(req.params.routerId, req.params.profileId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Hotspot profile not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });
}

module.exports = registerHotspotRoutes;
