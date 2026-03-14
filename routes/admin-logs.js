const { requireAdminPermission } = require('../middleware/admin-auth');
const {
    ADMIN_LOG_PERMISSIONS,
    SECURITY_REVIEW_NOTE_CATEGORIES,
    listGlobalActivity,
    getGlobalActivityEvent,
    listAuditTrail,
    getAuditDetail,
    getSecurityOverview,
    listSecurityEvents,
    getSecurityEventDetail,
    listSuspiciousActivity,
    listSecurityReviews,
    listSessions,
    listUserSessions,
    revokeSingleSession,
    revokeAllSessionsForUser,
    getUserSecuritySummary,
    getUserSecurityEvents,
    getUserSecurityReviews,
    markUserSecurityReviewed,
    getUserSecurityNotes,
    addUserSecurityNote,
    acknowledgeSecurityEvent,
    resolveSecurityEvent,
    markSecurityEventReviewed,
    getSecurityEventNotes,
    addSecurityEventNote,
    getUserTimeline,
    getRouterTimeline,
    getVpnServerTimeline,
    getBillingAccountTimeline,
    getSupportTicketTimeline,
    getIncidentTimeline
} = require('../services/admin-logs-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function registerAdminLogRoutes(app) {
    app.get('/api/admin/logs/activity', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await listGlobalActivity(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load activity log', details: error.message });
        }
    });

    app.get('/api/admin/logs/activity/:eventId', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const event = await getGlobalActivityEvent(req.params.eventId);
            if (!event) return res.status(404).json({ success: false, error: 'Activity event not found' });
            return res.json({ success: true, event });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load activity event', details: error.message });
        }
    });

    app.get('/api/admin/logs/search', requireAdminPermission(ADMIN_LOG_PERMISSIONS.SEARCH_LOGS), async (req, res) => {
        try {
            const data = await listGlobalActivity(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to search activity log', details: error.message });
        }
    });

    app.get('/api/admin/audit', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_AUDIT), async (req, res) => {
        try {
            const data = await listAuditTrail(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load audit trail', details: error.message });
        }
    });

    app.get('/api/admin/audit/:auditId', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_AUDIT), async (req, res) => {
        try {
            const item = await getAuditDetail(req.params.auditId);
            if (!item) return res.status(404).json({ success: false, error: 'Audit record not found' });
            return res.json({ success: true, audit: item });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load audit record', details: error.message });
        }
    });

    app.get('/api/admin/security/overview', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const overview = await getSecurityOverview();
            return res.json({ success: true, overview });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load security overview', details: error.message });
        }
    });

    app.get('/api/admin/security/events', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const data = await listSecurityEvents(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load security events', details: error.message });
        }
    });

    app.get('/api/admin/security/events/:eventId', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const event = await getSecurityEventDetail(req.params.eventId);
            if (!event) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, event });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load security event', details: error.message });
        }
    });

    app.get('/api/admin/security/suspicious', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const data = await listSuspiciousActivity(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load suspicious activity', details: error.message });
        }
    });

    app.get('/api/admin/security/reviews', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const data = await listSecurityReviews(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load security reviews', details: error.message });
        }
    });

    app.get('/api/admin/security/sessions', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SESSIONS), async (req, res) => {
        try {
            const data = await listSessions(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load sessions', details: error.message });
        }
    });

    app.get('/api/admin/security/users/:userId/sessions', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SESSIONS), async (req, res) => {
        try {
            const data = await listUserSessions(req.params.userId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user sessions', details: error.message });
        }
    });

    app.post('/api/admin/security/sessions/:sessionId/revoke', requireAdminPermission(ADMIN_LOG_PERMISSIONS.MANAGE_SESSIONS), async (req, res) => {
        try {
            const session = await revokeSingleSession(req.params.sessionId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
            return res.json({ success: true, message: 'Session revoked successfully', sessionId: session.sessionId, revokedAt: session.revokedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to revoke session', details: error.message });
        }
    });

    app.post('/api/admin/security/users/:userId/revoke-all-sessions', requireAdminPermission(ADMIN_LOG_PERMISSIONS.MANAGE_SESSIONS), async (req, res) => {
        try {
            const result = await revokeAllSessionsForUser(req.params.userId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!result) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, message: 'All user sessions revoked successfully', revokedCount: result.revokedCount, sessionsRevokedAt: result.user.sessionsRevokedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to revoke all user sessions', details: error.message });
        }
    });

    app.get('/api/admin/security/users/:userId/summary', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_USER_SECURITY), async (req, res) => {
        try {
            const summary = await getUserSecuritySummary(req.params.userId);
            if (!summary) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user security summary', details: error.message });
        }
    });

    app.get('/api/admin/security/users/:userId/events', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_USER_SECURITY), async (req, res) => {
        try {
            const data = await getUserSecurityEvents(req.params.userId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user security events', details: error.message });
        }
    });

    app.get('/api/admin/security/users/:userId/reviews', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_USER_SECURITY), async (req, res) => {
        try {
            const data = await getUserSecurityReviews(req.params.userId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user security reviews', details: error.message });
        }
    });

    app.post('/api/admin/security/users/:userId/mark-reviewed', requireAdminPermission(ADMIN_LOG_PERMISSIONS.REVIEW_SECURITY), async (req, res) => {
        try {
            const user = await markUserSecurityReviewed(req.params.userId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!user) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, message: 'User security marked as reviewed', reviewedAt: user.lastSecurityReviewAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark user security reviewed', details: error.message });
        }
    });

    app.get('/api/admin/security/users/:userId/notes', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_USER_SECURITY), async (req, res) => {
        try {
            const notes = await getUserSecurityNotes(req.params.userId);
            if (!notes) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user security notes', details: error.message });
        }
    });

    app.post('/api/admin/security/users/:userId/notes', requireAdminPermission(ADMIN_LOG_PERMISSIONS.REVIEW_SECURITY), async (req, res) => {
        try {
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            const user = await addUserSecurityNote(req.params.userId, req.adminUser, req.body || {}, req);
            if (!user) return res.status(404).json({ success: false, error: 'User not found' });
            return res.json({ success: true, message: 'User security note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add user security note', details: error.message });
        }
    });

    app.get('/api/admin/logs/users/:userId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getUserTimeline(req.params.userId, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load user timeline', details: error.message });
        }
    });

    app.get('/api/admin/logs/routers/:routerId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getRouterTimeline(req.params.routerId, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router timeline', details: error.message });
        }
    });

    app.get('/api/admin/logs/vpn-servers/:serverId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getVpnServerTimeline(req.params.serverId, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load VPN server timeline', details: error.message });
        }
    });

    app.get('/api/admin/logs/billing/accounts/:accountId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getBillingAccountTimeline(req.params.accountId, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing account timeline', details: error.message });
        }
    });

    app.get('/api/admin/logs/support/tickets/:ticketId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getSupportTicketTimeline(req.params.ticketId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support ticket timeline', details: error.message });
        }
    });

    app.get('/api/admin/logs/incidents/:incidentId/timeline', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_LOGS), async (req, res) => {
        try {
            const data = await getIncidentTimeline(req.params.incidentId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'Incident not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load incident timeline', details: error.message });
        }
    });

    app.post('/api/admin/security/events/:eventId/acknowledge', requireAdminPermission(ADMIN_LOG_PERMISSIONS.REVIEW_SECURITY), async (req, res) => {
        try {
            const event = await acknowledgeSecurityEvent(req.params.eventId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!event) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, message: 'Security event acknowledged successfully', acknowledgedAt: event.acknowledgedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to acknowledge security event', details: error.message });
        }
    });

    app.post('/api/admin/security/events/:eventId/resolve', requireAdminPermission(ADMIN_LOG_PERMISSIONS.RESOLVE_SECURITY), async (req, res) => {
        try {
            const event = await resolveSecurityEvent(req.params.eventId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!event) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, message: 'Security event resolved successfully', resolvedAt: event.resolvedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to resolve security event', details: error.message });
        }
    });

    app.post('/api/admin/security/events/:eventId/mark-reviewed', requireAdminPermission(ADMIN_LOG_PERMISSIONS.REVIEW_SECURITY), async (req, res) => {
        try {
            const event = await markSecurityEventReviewed(req.params.eventId, req.adminUser, normalizeReason(req.body?.reason), req);
            if (!event) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, message: 'Security event marked as reviewed', reviewedAt: event.reviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark security event reviewed', details: error.message });
        }
    });

    app.get('/api/admin/security/events/:eventId/notes', requireAdminPermission(ADMIN_LOG_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
        try {
            const notes = await getSecurityEventNotes(req.params.eventId);
            if (!notes) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load security event notes', details: error.message });
        }
    });

    app.post('/api/admin/security/events/:eventId/notes', requireAdminPermission(ADMIN_LOG_PERMISSIONS.REVIEW_SECURITY), async (req, res) => {
        try {
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !SECURITY_REVIEW_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid security review note category', categories: SECURITY_REVIEW_NOTE_CATEGORIES });
            }
            const event = await addSecurityEventNote(req.params.eventId, req.adminUser, req.body || {}, req);
            if (!event) return res.status(404).json({ success: false, error: 'Security event not found' });
            return res.json({ success: true, message: 'Security event note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add security event note', details: error.message });
        }
    });
}

module.exports = registerAdminLogRoutes;
