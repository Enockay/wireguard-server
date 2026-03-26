const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    listPppoeSecrets,
    createPppoeSecret,
    updatePppoeSecret,
    deletePppoeSecret,
    listActiveSessions,
    disconnectSession,
    listProfiles,
    createProfile,
    updateProfile,
    deleteProfile
} = require('../services/pppoe-service');
const PppoeSecret = require('../models/PppoeSecret');

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

function registerPppoeRoutes(app) {
    app.get('/api/admin/routers/:routerId/pppoe/secrets', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const { page = 1, limit = 50, search = '' } = req.query;
            const result = await listPppoeSecrets(req.params.routerId, page, limit, search);
            return res.json({ success: true, data: result.items, pagination: result.pagination });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/pppoe/secrets', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { name, password } = req.body || {};
            if (!name || !password) {
                return res.status(400).json({ success: false, error: 'Subscriber name and password are required' });
            }
            const data = await createPppoeSecret(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.put('/api/admin/routers/:routerId/pppoe/secrets/:secretId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const secret = await PppoeSecret.findOne({ _id: req.params.secretId, routerId: req.params.routerId });
            if (!secret) {
                return res.status(404).json({ success: false, error: 'PPPoE subscriber not found' });
            }
            const data = await updatePppoeSecret(req.params.routerId, secret.routerosId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'PPPoE subscriber not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/pppoe/secrets/:secretId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const secret = await PppoeSecret.findOne({ _id: req.params.secretId, routerId: req.params.routerId });
            if (!secret) {
                return res.status(404).json({ success: false, error: 'PPPoE subscriber not found' });
            }
            const data = await deletePppoeSecret(req.params.routerId, secret.routerosId, req.params.secretId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'PPPoE subscriber not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/pppoe/sessions', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_MONITORING), async (req, res) => {
        try {
            const data = await listActiveSessions(req.params.routerId);
            return res.json({ success: true, data, pagination: { page: 1, limit: data.length, total: data.length, pages: 1 } });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/pppoe/sessions/:sessionId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await disconnectSession(req.params.routerId, req.params.sessionId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.get('/api/admin/routers/:routerId/pppoe/profiles', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await listProfiles(req.params.routerId);
            return res.json({ success: true, data, pagination: { page: 1, limit: data.length, total: data.length, pages: 1 } });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/pppoe/profiles', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
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

    app.put('/api/admin/routers/:routerId/pppoe/profiles/:profileId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await updateProfile(req.params.routerId, req.params.profileId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'PPPoE profile not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/pppoe/profiles/:profileId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const data = await deleteProfile(req.params.routerId, req.params.profileId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'PPPoE profile not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });
}

module.exports = registerPppoeRoutes;
