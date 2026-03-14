const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const {
    ADMIN_MONITORING_PERMISSIONS,
    INCIDENT_NOTE_CATEGORIES,
    getMonitoringOverview,
    getMonitoringTrends,
    getMonitoringActivity,
    getMonitoringDiagnostics,
    getRouterHealthSummary,
    listUnhealthyRouters,
    listOfflineRouters,
    listProvisioningIssueRouters,
    listStaleRouters,
    getVpnServerHealthSummary,
    listUnhealthyVpnServers,
    listOverloadedVpnServers,
    listStaleVpnServers,
    getPeerHealthSummary,
    listStalePeers,
    listUnhealthyPeers,
    getTrafficSummary,
    getTrafficTrends,
    getTopTrafficRouters,
    getTopTrafficServers,
    getCustomerImpactSummary,
    listAffectedCustomers,
    getProvisioningSummary,
    getProvisioningTrends,
    listProvisioningFailures,
    listMonitoringIncidents,
    getMonitoringIncidentDetail,
    getMonitoringIncidentDocument,
    acknowledgeMonitoringIncident,
    resolveMonitoringIncident,
    markMonitoringIncidentReviewed,
    getMonitoringIncidentNotes,
    addMonitoringIncidentNote
} = require('../services/admin-monitoring-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

async function getIncidentOr404(req, res) {
    const incident = await getMonitoringIncidentDocument(req.params.incidentId);
    if (!incident) {
        res.status(404).json({ success: false, error: 'Incident not found' });
        return null;
    }
    return incident;
}

async function auditIncident(req, incident, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId: incident.relatedUserId || null,
        targetRouterId: incident.relatedRouterId || null,
        targetServerId: incident.relatedServerId || null,
        targetIncidentId: incident._id,
        action,
        reason,
        metadata
    });
}

function registerAdminMonitoringRoutes(app) {
    app.get('/api/admin/monitoring/overview', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const overview = await getMonitoringOverview();
            return res.json({ success: true, overview });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load monitoring overview', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/trends', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const trends = await getMonitoringTrends(req.query || {});
            return res.json({ success: true, trends });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load monitoring trends', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/activity', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const activity = await getMonitoringActivity(req.query || {});
            return res.json({ success: true, items: activity.items, pagination: activity.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load monitoring activity', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/diagnostics', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_DIAGNOSTICS), async (req, res) => {
        try {
            const diagnostics = await getMonitoringDiagnostics();
            return res.json({ success: true, diagnostics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load monitoring diagnostics', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/routers/summary', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const summary = await getRouterHealthSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router health summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/routers/unhealthy', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const data = await listUnhealthyRouters(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load unhealthy routers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/routers/offline', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const data = await listOfflineRouters(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load offline routers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/routers/provisioning-issues', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const data = await listProvisioningIssueRouters(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router provisioning issues', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/routers/stale', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const data = await listStaleRouters(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load stale routers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/vpn-servers/summary', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_SERVER_HEALTH), async (req, res) => {
        try {
            const summary = await getVpnServerHealthSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server health summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/vpn-servers/unhealthy', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_SERVER_HEALTH), async (req, res) => {
        try {
            const data = await listUnhealthyVpnServers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load unhealthy VPN servers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/vpn-servers/overloaded', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_SERVER_HEALTH), async (req, res) => {
        try {
            const data = await listOverloadedVpnServers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load overloaded VPN servers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/vpn-servers/stale', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_SERVER_HEALTH), async (req, res) => {
        try {
            const data = await listStaleVpnServers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load stale VPN servers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/peers/summary', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_PEER_HEALTH), async (req, res) => {
        try {
            const summary = await getPeerHealthSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load peer health summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/peers/stale', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_PEER_HEALTH), async (req, res) => {
        try {
            const data = await listStalePeers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load stale peers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/peers/unhealthy', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_PEER_HEALTH), async (req, res) => {
        try {
            const data = await listUnhealthyPeers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load unhealthy peers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/traffic/summary', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_TRAFFIC), async (req, res) => {
        try {
            const summary = await getTrafficSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load traffic summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/traffic/trends', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_TRAFFIC), async (req, res) => {
        try {
            const trends = await getTrafficTrends(req.query || {});
            return res.json({ success: true, trends });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load traffic trends', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/traffic/top-routers', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_TRAFFIC), async (req, res) => {
        try {
            const data = await getTopTrafficRouters(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load top traffic routers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/traffic/top-servers', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_TRAFFIC), async (req, res) => {
        try {
            const data = await getTopTrafficServers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load top traffic servers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/customers/impact', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_CUSTOMER_IMPACT), async (req, res) => {
        try {
            const impact = await getCustomerImpactSummary();
            return res.json({ success: true, impact });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load customer impact summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/customers/affected', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_CUSTOMER_IMPACT), async (req, res) => {
        try {
            const data = await listAffectedCustomers(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load affected customers', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/provisioning/summary', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const summary = await getProvisioningSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load provisioning summary', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/provisioning/trends', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const trends = await getProvisioningTrends(req.query || {});
            return res.json({ success: true, trends });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load provisioning trends', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/provisioning/failures', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_ROUTER_HEALTH), async (req, res) => {
        try {
            const data = await listProvisioningFailures(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load provisioning failures', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/incidents', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_INCIDENTS), async (req, res) => {
        try {
            const data = await listMonitoringIncidents(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load incidents', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/incidents/:incidentId', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_INCIDENTS), async (req, res) => {
        try {
            const incident = await getMonitoringIncidentDetail(req.params.incidentId);
            if (!incident) {
                return res.status(404).json({ success: false, error: 'Incident not found' });
            }
            return res.json({ success: true, incident });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load incident detail', details: error.message });
        }
    });

    app.post('/api/admin/monitoring/incidents/:incidentId/acknowledge', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.MANAGE_INCIDENTS), async (req, res) => {
        try {
            const incident = await getIncidentOr404(req, res);
            if (!incident) return;
            await acknowledgeMonitoringIncident(incident._id, req.adminUser.email);
            await auditIncident(req, incident, 'admin.monitoring.incidents.acknowledge', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Incident acknowledged successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to acknowledge incident', details: error.message });
        }
    });

    app.post('/api/admin/monitoring/incidents/:incidentId/resolve', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.MANAGE_INCIDENTS), async (req, res) => {
        try {
            const incident = await getIncidentOr404(req, res);
            if (!incident) return;
            await resolveMonitoringIncident(incident._id, req.adminUser.email);
            await auditIncident(req, incident, 'admin.monitoring.incidents.resolve', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Incident resolved successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to resolve incident', details: error.message });
        }
    });

    app.post('/api/admin/monitoring/incidents/:incidentId/mark-reviewed', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.MANAGE_INCIDENTS), async (req, res) => {
        try {
            const incident = await getIncidentOr404(req, res);
            if (!incident) return;
            await markMonitoringIncidentReviewed(incident._id, req.adminUser.email);
            await auditIncident(req, incident, 'admin.monitoring.incidents.mark_reviewed', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Incident marked as reviewed' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark incident reviewed', details: error.message });
        }
    });

    app.get('/api/admin/monitoring/incidents/:incidentId/notes', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.VIEW_INCIDENTS), async (req, res) => {
        try {
            const notes = await getMonitoringIncidentNotes(req.params.incidentId);
            if (!notes) {
                return res.status(404).json({ success: false, error: 'Incident not found' });
            }
            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load incident notes', details: error.message });
        }
    });

    app.post('/api/admin/monitoring/incidents/:incidentId/notes', requireAdminPermission(ADMIN_MONITORING_PERMISSIONS.MANAGE_INCIDENTS), async (req, res) => {
        try {
            const incident = await getIncidentOr404(req, res);
            if (!incident) return;
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !INCIDENT_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid incident note category', categories: INCIDENT_NOTE_CATEGORIES });
            }
            await addMonitoringIncidentNote(incident._id, {
                body: req.body.body,
                category: req.body.category || 'incident',
                author: req.adminUser.email
            });
            await auditIncident(req, incident, 'admin.monitoring.incidents.add_note', normalizeReason(req.body?.reason), {
                category: req.body.category || 'incident'
            });
            return res.json({ success: true, message: 'Incident note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add incident note', details: error.message });
        }
    });
}

module.exports = registerAdminMonitoringRoutes;
