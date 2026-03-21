const RouterQueue = require('../models/RouterQueue');
const ServicePlan = require('../models/ServicePlan');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    listQueues,
    createQueue,
    updateQueue,
    deleteQueue,
    applyPlanToSubscriber,
    getQueueStats
} = require('../services/queue-service');

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

function registerQueueRoutes(app) {
    app.get('/api/admin/routers/:routerId/queues', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const { page = 1, limit = 50 } = req.query;
            const result = await listQueues(req.params.routerId, page, limit);
            const stats = await getQueueStats(req.params.routerId);
            return res.json({ success: true, data: result.items, pagination: result.pagination, stats });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/queues', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { name, target } = req.body || {};
            if (!name || !target) {
                return res.status(400).json({ success: false, error: 'Queue name and target are required' });
            }
            const data = await createQueue(req.params.routerId, req.body || {});
            return res.status(201).json({ success: true, data });
        } catch (error) {
            const resolved = resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.put('/api/admin/routers/:routerId/queues/:queueId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const queue = await RouterQueue.findOne({ _id: req.params.queueId, routerId: req.params.routerId });
            if (!queue) {
                return res.status(404).json({ success: false, error: 'Queue not found' });
            }
            const data = await updateQueue(req.params.routerId, queue.routerosId, req.body || {});
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Queue not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.delete('/api/admin/routers/:routerId/queues/:queueId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const queue = await RouterQueue.findOne({ _id: req.params.queueId, routerId: req.params.routerId });
            if (!queue) {
                return res.status(404).json({ success: false, error: 'Queue not found' });
            }
            const data = await deleteQueue(req.params.routerId, queue.routerosId, req.params.queueId);
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Queue not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });

    app.post('/api/admin/routers/:routerId/queues/apply-plan', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const { subscriberIp, servicePlanId, subscriptionId } = req.body || {};
            if (!subscriberIp || !servicePlanId) {
                return res.status(400).json({ success: false, error: 'Subscriber IP and service plan are required' });
            }
            const servicePlan = await ServicePlan.findById(servicePlanId);
            if (!servicePlan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }
            const data = await applyPlanToSubscriber(req.params.routerId, subscriberIp, servicePlan, subscriptionId || null);
            if (subscriptionId) {
                await Subscription.findByIdAndUpdate(subscriptionId, {
                    servicePlanId: servicePlan._id,
                    queueName: data.name
                }).catch(() => undefined);
            }
            return res.json({ success: true, data });
        } catch (error) {
            const resolved = error.message === 'Service plan not found'
                ? { status: 404, payload: { success: false, error: error.message } }
                : resolveRouterFeatureError(error);
            return res.status(resolved.status).json(resolved.payload);
        }
    });
}

const Subscription = require('../models/Subscription');

module.exports = registerQueueRoutes;
