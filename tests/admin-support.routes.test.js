const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDoc,
    createPermissionProxy,
    createRouteTestContext,
    withRouteApp
} = require('./helpers/test-kit');

const routeModulePath = 'routes/admin-support.js';

function createSupportRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const ticket = overrides.ticket || createDoc({ _id: '507f1f77bcf86cd799439111', userId: '507f1f77bcf86cd799439112' });

    const service = {
        ADMIN_SUPPORT_PERMISSIONS: createPermissionProxy(),
        SUPPORT_NOTE_CATEGORIES: ['support', 'billing'],
        SUPPORT_FLAG_TYPES: ['vip_customer', 'manual_review'],
        SUPPORT_FLAG_SEVERITIES: ['low', 'medium', 'high'],
        SUPPORT_TEAMS: ['general', 'billing', 'operations'],
        async getSupportOverview() { return { totalTickets: 1 }; },
        async getSupportAnalytics() { return { trends: [] }; },
        async listAdminSupportTickets() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminSupportTicketDetail() { return ticket; },
        async getAdminSupportTicketActivity() { return { items: [{ id: 'act-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminSupportTicketMessages() { return { items: [{ id: 'msg-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getAdminSupportTicketContext() { return { ticketId: ticket._id }; },
        async assignTicket() { return { ticket, previousAssignee: null, assignee: { id: 'admin-2' } }; },
        async unassignTicket() { return { ticket, previousAssignee: { id: 'admin-2' } }; },
        async updateTicketStatus(_ticketId, status) { return { ticket, previousStatus: 'open', status }; },
        async changeTicketPriority(_ticketId, priority) { return { ticket, previousPriority: 'medium', priority }; },
        async changeTicketCategory(_ticketId, category) { return { ticket, previousCategory: 'general', category }; },
        async escalateTicket() { return ticket; },
        async deescalateTicket() { return ticket; },
        async replyToTicket() { return ticket; },
        async markTicketReviewed() { return { ...ticket, lastReviewedAt: '2026-03-14T00:00:00.000Z' }; },
        async updateTicketContext() { return { ticket, before: {}, after: {} }; },
        async getTicketNotes() { return { items: [{ body: 'note' }] }; },
        async addTicketNote() { return { body: 'note' }; },
        async getTicketFlags() { return { items: [{ flag: 'vip_customer' }] }; },
        async addTicketFlag() { return { flag: 'vip_customer' }; },
        async removeTicketFlag() { return { flag: 'vip_customer' }; },
        async getUnassignedQueue() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getEscalatedQueue() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getStaleQueue() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getWorkloadByAssignee() { return [{ adminId: 'admin-2', openTickets: 1 }]; },
        async assignTicketTeam() { return { ticket, previousTeam: 'general', team: 'billing' }; },
        async getWorkloadByTeam() { return [{ team: 'general', openTickets: 1 }]; },
        async getTeamTickets() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listSupportAgents() { return [{ id: 'admin-2', email: 'agent@test.local' }]; },
        async getAssigneeTickets() { return { items: [ticket], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        ...overrides.service
    };

    const userModel = {
        async findById(id) { return id === 'admin-2' ? { _id: 'admin-2', role: 'admin' } : null; },
        ...overrides.userModel
    };

    const attachments = {
        storeSupportAttachments(_ticketId, files) { return files || []; }
    };

    return {
        ctx,
        ticket,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/admin-support-service.js': service,
            'services/support-attachment-service.js': attachments,
            'models/User.js': userModel
        }
    };
}

test('admin support routes enforce auth and serve read endpoints', async () => {
    const { mocks, ticket } = createSupportRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('GET', '/api/admin/support/overview', { token: null })).response.status, 401);
        for (const path of [
            '/api/admin/support/overview',
            '/api/admin/support/analytics',
            '/api/admin/support/tickets',
            `/api/admin/support/tickets/${ticket._id}`,
            `/api/admin/support/tickets/${ticket._id}/activity`,
            `/api/admin/support/tickets/${ticket._id}/messages`,
            `/api/admin/support/tickets/${ticket._id}/context`,
            `/api/admin/support/tickets/${ticket._id}/notes`,
            `/api/admin/support/tickets/${ticket._id}/flags`,
            '/api/admin/support/queues/unassigned',
            '/api/admin/support/queues/escalated',
            '/api/admin/support/queues/stale',
            '/api/admin/support/queues/by-assignee',
            '/api/admin/support/queues/by-team',
            '/api/admin/support/teams/general/tickets',
            '/api/admin/support/agents',
            '/api/admin/support/assignees/admin-2/tickets'
        ]) {
            assert.equal((await request('GET', path)).response.status, 200, path);
        }

        assert.equal((await request('GET', '/api/admin/support/teams/invalid/tickets')).response.status, 400);
        assert.equal((await request('GET', '/api/admin/support/assignees/missing/tickets')).response.status, 404);
    });
});

test('admin support mutations validate payloads and complete workflow actions', async () => {
    const { mocks, ctx, ticket } = createSupportRouteMocks({
        service: {
            async replyToTicket() { return false; }
        }
    });
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/assign`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/assign`, { body: { assigneeId: 'admin-2', reason: 'queue' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/reassign`, { body: { assigneeId: 'admin-2', reason: 'queue' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/unassign`, { body: { reason: 'unowned' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/status`, { body: { status: 'bad' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/status`, { body: { status: 'resolved' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/priority`, { body: { priority: 'bad' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/priority`, { body: { priority: 'urgent' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/category`, { body: { category: 'bad' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/category`, { body: { category: 'billing' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/escalate`, { body: { reason: 'vip' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/de-escalate`, { body: { reason: 'fixed' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/reopen`, { body: { reason: 'follow-up' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/resolve`, { body: { reason: 'done' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/close`, { body: { reason: 'archived' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/reply`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/support/tickets/${ticket._id}/reply`, { body: { message: 'hello' } })).response.status, 400);

        const goodReply = createSupportRouteMocks();
        await withRouteApp({ routeModulePath, mocks: goodReply.mocks }, async ({ request: request2 }) => {
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/reply`, { body: { message: 'hello', attachments: [] } })).response.status, 200);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/team`, { body: { team: 'invalid' } })).response.status, 400);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/team`, { body: { team: 'billing' } })).response.status, 200);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/context`, { body: { routerId: 'r1' } })).response.status, 200);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/notes`, { body: {} })).response.status, 400);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/notes`, { body: { body: 'x', category: 'invalid' } })).response.status, 400);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/notes`, { body: { body: 'internal', category: 'support' } })).response.status, 201);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/flags`, { body: { flag: 'invalid' } })).response.status, 400);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/flags`, { body: { flag: 'vip_customer', severity: 'critical' } })).response.status, 400);
            assert.equal((await request2('POST', `/api/admin/support/tickets/${goodReply.ticket._id}/flags`, { body: { flag: 'vip_customer', severity: 'high' } })).response.status, 201);
            assert.equal((await request2('DELETE', `/api/admin/support/tickets/${goodReply.ticket._id}/flags/flag-1`, { body: { reason: 'clear' } })).response.status, 200);
        });

        assert.ok(ctx.auditCalls.length >= 10);
    });
});
