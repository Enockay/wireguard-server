const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDoc,
    createPermissionProxy,
    createRouteTestContext,
    withRouteApp
} = require('./helpers/test-kit');

const routeModulePath = 'routes/admin-logs.js';

function createLogsRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const user = createDoc({ _id: '507f1f77bcf86cd799439101' });
    const securityEvent = createDoc({ _id: '507f1f77bcf86cd799439102', eventType: 'login_failed' });
    const session = createDoc({ _id: '507f1f77bcf86cd799439103', sessionId: 'session-1' });

    const service = {
        ADMIN_LOG_PERMISSIONS: createPermissionProxy(),
        SECURITY_REVIEW_NOTE_CATEGORIES: ['review', 'resolution'],
        async listGlobalActivity() { return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getGlobalActivityEvent() { return { id: 'activity-1' }; },
        async listAuditTrail() { return { items: [{ id: 'audit-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAuditDetail() { return { id: 'audit-1' }; },
        async getSecurityOverview() { return { totalFailedLogins: 1 }; },
        async listSecurityEvents() { return { items: [securityEvent], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getSecurityEventDetail() { return securityEvent; },
        async listSuspiciousActivity() { return { items: [securityEvent], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listSecurityReviews() { return { items: [securityEvent], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listSessions() { return { items: [session], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listUserSessions() { return { items: [session], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async revokeSingleSession() { return { sessionId: 'session-1', revokedAt: '2026-03-14T00:00:00.000Z' }; },
        async revokeAllSessionsForUser() { return { revokedCount: 2, user: { sessionsRevokedAt: '2026-03-14T00:00:00.000Z' } }; },
        async getUserSecuritySummary() { return { user: { id: user._id } }; },
        async getUserSecurityEvents() { return { items: [securityEvent], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getUserSecurityReviews() { return { items: [securityEvent], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async markUserSecurityReviewed() { return { lastSecurityReviewAt: '2026-03-14T00:00:00.000Z' }; },
        async getUserSecurityNotes() { return [{ body: 'note' }]; },
        async addUserSecurityNote() { return { body: 'note' }; },
        async acknowledgeSecurityEvent() { return securityEvent; },
        async resolveSecurityEvent() { return securityEvent; },
        async markSecurityEventReviewed() { return securityEvent; },
        async getSecurityEventNotes() { return [{ body: 'note' }]; },
        async addSecurityEventNote() { return { body: 'note' }; },
        async getUserTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getRouterTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getVpnServerTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getBillingAccountTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getSupportTicketTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getIncidentTimeline() { return { items: [{ id: 'timeline-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        ...overrides.service
    };

    return {
        ctx,
        user,
        securityEvent,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-logs-service.js': service
        }
    };
}

test('admin logs and security routes enforce auth and return read payloads', async () => {
    const { mocks, user, securityEvent } = createLogsRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('GET', '/api/admin/logs/activity', { token: null })).response.status, 401);
        for (const path of [
            '/api/admin/logs/activity',
            '/api/admin/logs/activity/activity-1',
            '/api/admin/logs/search',
            '/api/admin/audit',
            '/api/admin/audit/audit-1',
            '/api/admin/security/overview',
            '/api/admin/security/events',
            `/api/admin/security/events/${securityEvent._id}`,
            '/api/admin/security/suspicious',
            '/api/admin/security/reviews',
            '/api/admin/security/sessions',
            `/api/admin/security/users/${user._id}/sessions`,
            `/api/admin/security/users/${user._id}/summary`,
            `/api/admin/security/users/${user._id}/events`,
            `/api/admin/security/users/${user._id}/reviews`,
            `/api/admin/security/users/${user._id}/notes`,
            `/api/admin/logs/users/${user._id}/timeline`,
            '/api/admin/logs/routers/router-1/timeline',
            '/api/admin/logs/vpn-servers/server-1/timeline',
            '/api/admin/logs/billing/accounts/account-1/timeline',
            '/api/admin/logs/support/tickets/ticket-1/timeline',
            '/api/admin/logs/incidents/incident-1/timeline',
            `/api/admin/security/events/${securityEvent._id}/notes`
        ]) {
            assert.equal((await request('GET', path)).response.status, 200, path);
        }
    });
});

test('admin logs and security mutation routes validate note payloads and complete review actions', async () => {
    const { mocks, user, securityEvent } = createLogsRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', '/api/admin/security/sessions/session-1/revoke', { body: { reason: 'security' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/users/${user._id}/revoke-all-sessions`, { body: { reason: 'incident' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/users/${user._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/users/${user._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/security/users/${user._id}/notes`, { body: { body: 'review', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/security/users/${user._id}/notes`, { body: { body: 'review', category: 'review' } })).response.status, 201);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/acknowledge`, { body: { reason: 'triage' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/resolve`, { body: { reason: 'resolved' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/notes`, { body: { body: 'note', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/security/events/${securityEvent._id}/notes`, { body: { body: 'note', category: 'review' } })).response.status, 201);
    });
});
