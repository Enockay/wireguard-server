const User = require('../models/User');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const { storeSupportAttachments } = require('../services/support-attachment-service');
const {
    ADMIN_SUPPORT_PERMISSIONS,
    SUPPORT_NOTE_CATEGORIES,
    SUPPORT_FLAG_TYPES,
    SUPPORT_FLAG_SEVERITIES,
    SUPPORT_TEAMS,
    getSupportOverview,
    getSupportAnalytics,
    listAdminSupportTickets,
    getAdminSupportTicketDetail,
    getAdminSupportTicketMessages,
    getAdminSupportTicketContext,
    getAdminSupportTicketActivity,
    getTicketNotes,
    addTicketNote,
    getTicketFlags,
    addTicketFlag,
    removeTicketFlag,
    assignTicket,
    assignTicketTeam,
    unassignTicket,
    updateTicketStatus,
    changeTicketPriority,
    changeTicketCategory,
    escalateTicket,
    deescalateTicket,
    replyToTicket,
    markTicketReviewed,
    updateTicketContext,
    getUnassignedQueue,
    getEscalatedQueue,
    getStaleQueue,
    getWorkloadByAssignee,
    getWorkloadByTeam,
    getTeamTickets,
    getAssigneeTickets,
    listSupportAgents
} = require('../services/admin-support-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function normalizeString(value) {
    return value ? String(value).trim() : '';
}

async function audit(req, targetTicketId, targetUserId, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetTicketId,
        targetUserId,
        action,
        reason,
        metadata
    });
}

function registerAdminSupportRoutes(app) {
    app.get('/api/admin/support/overview', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const overview = await getSupportOverview();
            return res.json({ success: true, overview });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support overview', details: error.message });
        }
    });

    app.get('/api/admin/support/analytics', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_ANALYTICS), async (req, res) => {
        try {
            const analytics = await getSupportAnalytics(req.query || {});
            return res.json({ success: true, analytics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support analytics', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const data = await listAdminSupportTickets(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support tickets', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getAdminSupportTicketDetail(req.params.ticketId);
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support ticket', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId/activity', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getAdminSupportTicketActivity(req.params.ticketId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support ticket activity', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId/messages', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getAdminSupportTicketMessages(req.params.ticketId, req.query || {});
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support ticket messages', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId/context', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const context = await getAdminSupportTicketContext(req.params.ticketId);
            if (!context) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, context });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support ticket context', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/assign', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.ASSIGN), async (req, res) => {
        try {
            const assigneeId = normalizeString(req.body?.assigneeId);
            if (!assigneeId) return res.status(400).json({ success: false, error: 'assigneeId is required' });
            const reason = normalizeReason(req.body?.reason);
            const result = await assignTicket(req.params.ticketId, assigneeId, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket or assignee not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.assign', reason, {
                previousAssignee: result.previousAssignee,
                assignee: result.assignee
            });
            return res.json({ success: true, message: 'Ticket assigned successfully', assignee: result.assignee });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to assign support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/reassign', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.REASSIGN), async (req, res) => {
        try {
            const assigneeId = normalizeString(req.body?.assigneeId);
            if (!assigneeId) return res.status(400).json({ success: false, error: 'assigneeId is required' });
            const reason = normalizeReason(req.body?.reason);
            const result = await assignTicket(req.params.ticketId, assigneeId, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket or assignee not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.reassign', reason, {
                previousAssignee: result.previousAssignee,
                assignee: result.assignee
            });
            return res.json({ success: true, message: 'Ticket reassigned successfully', assignee: result.assignee });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reassign support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/unassign', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.REASSIGN), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const result = await unassignTicket(req.params.ticketId, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.unassign', reason, {
                previousAssignee: result.previousAssignee
            });
            return res.json({ success: true, message: 'Ticket unassigned successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to unassign support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/status', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const status = normalizeString(req.body?.status);
            if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
                return res.status(400).json({ success: false, error: 'Invalid status' });
            }
            const reason = normalizeReason(req.body?.reason);
            const result = await updateTicketStatus(req.params.ticketId, status, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.status', reason, {
                from: result.previousStatus,
                to: result.status
            });
            return res.json({ success: true, message: 'Ticket status updated successfully', status: result.status });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update support ticket status', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/priority', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_PRIORITY), async (req, res) => {
        try {
            const priority = normalizeString(req.body?.priority);
            if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
                return res.status(400).json({ success: false, error: 'Invalid priority' });
            }
            const reason = normalizeReason(req.body?.reason);
            const result = await changeTicketPriority(req.params.ticketId, priority, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.priority', reason, {
                from: result.previousPriority,
                to: result.priority
            });
            return res.json({ success: true, message: 'Ticket priority updated successfully', priority: result.priority });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update support ticket priority', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/category', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_PRIORITY), async (req, res) => {
        try {
            const category = normalizeString(req.body?.category);
            if (!['technical', 'billing', 'general', 'feature_request', 'bug_report'].includes(category)) {
                return res.status(400).json({ success: false, error: 'Invalid category' });
            }
            const reason = normalizeReason(req.body?.reason);
            const result = await changeTicketCategory(req.params.ticketId, category, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.category', reason, {
                from: result.previousCategory,
                to: result.category
            });
            return res.json({ success: true, message: 'Ticket category updated successfully', category: result.category });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update support ticket category', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/escalate', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.ESCALATE), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const ticket = await escalateTicket(req.params.ticketId, reason, req.adminUser._id);
            if (!ticket) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, ticket._id, ticket.userId?._id || ticket.userId, 'admin.support.escalate', reason, { escalated: true });
            return res.json({ success: true, message: 'Ticket escalated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to escalate support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/de-escalate', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.ESCALATE), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const ticket = await deescalateTicket(req.params.ticketId, req.adminUser._id);
            if (!ticket) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, ticket._id, ticket.userId?._id || ticket.userId, 'admin.support.deescalate', reason, { escalated: false });
            return res.json({ success: true, message: 'Ticket de-escalated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to de-escalate support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/reopen', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const result = await updateTicketStatus(req.params.ticketId, 'in_progress', req.adminUser._id, 'Support ticket reopened');
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.reopen', reason, {
                from: result.previousStatus,
                to: result.status
            });
            return res.json({ success: true, message: 'Ticket reopened successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reopen support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/resolve', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const result = await updateTicketStatus(req.params.ticketId, 'resolved', req.adminUser._id, 'Support ticket resolved');
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.resolve', reason, {
                from: result.previousStatus,
                to: result.status
            });
            return res.json({ success: true, message: 'Ticket resolved successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to resolve support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/close', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const result = await updateTicketStatus(req.params.ticketId, 'closed', req.adminUser._id, 'Support ticket closed');
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.close', reason, {
                from: result.previousStatus,
                to: result.status
            });
            return res.json({ success: true, message: 'Ticket closed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to close support ticket', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/reply', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.REPLY), async (req, res) => {
        try {
            const message = normalizeString(req.body?.message);
            if (!message) return res.status(400).json({ success: false, error: 'message is required' });
            const attachments = storeSupportAttachments(req.params.ticketId, req.body?.attachments || []);
            const reason = normalizeReason(req.body?.reason);
            const ticket = await replyToTicket(req.params.ticketId, { userId: req.adminUser._id, message, attachments });
            if (ticket === false) return res.status(400).json({ success: false, error: 'Cannot reply to closed ticket' });
            if (!ticket) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, ticket._id, ticket.userId?._id || ticket.userId, 'admin.support.reply', reason, {
                attachmentCount: attachments.length
            });
            return res.json({ success: true, message: 'Reply added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add support reply', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/team', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.ASSIGN), async (req, res) => {
        try {
            const team = normalizeString(req.body?.team);
            const reason = normalizeReason(req.body?.reason);
            if (!SUPPORT_TEAMS.includes(team)) {
                return res.status(400).json({ success: false, error: 'Invalid support team' });
            }
            const result = await assignTicketTeam(req.params.ticketId, team, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.assign_team', reason, {
                from: result.previousTeam,
                to: result.team
            });
            return res.json({ success: true, message: 'Ticket team updated successfully', team: result.team });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update support ticket team', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/mark-reviewed', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const ticket = await markTicketReviewed(req.params.ticketId, req.adminUser._id);
            if (!ticket) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, ticket._id, ticket.userId?._id || ticket.userId, 'admin.support.mark_reviewed', reason, {});
            return res.json({ success: true, message: 'Ticket reviewed successfully', reviewedAt: ticket.lastReviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark support ticket reviewed', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/context', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const result = await updateTicketContext(req.params.ticketId, req.body || {}, req.adminUser._id);
            if (!result) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, result.ticket._id, result.ticket.userId?._id || result.ticket.userId, 'admin.support.context', reason, {
                before: result.before,
                after: result.after
            });
            return res.json({ success: true, message: 'Ticket context updated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update support ticket context', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId/notes', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getTicketNotes(req.params.ticketId);
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, items: data.items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support notes', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/notes', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.ADD_INTERNAL_NOTE), async (req, res) => {
        try {
            const body = normalizeString(req.body?.body);
            const category = normalizeString(req.body?.category || 'support');
            const pinned = Boolean(req.body?.pinned);
            const reason = normalizeReason(req.body?.reason);
            if (!body) return res.status(400).json({ success: false, error: 'body is required' });
            if (!SUPPORT_NOTE_CATEGORIES.includes(category)) {
                return res.status(400).json({ success: false, error: 'Invalid note category' });
            }
            const note = await addTicketNote(req.params.ticketId, {
                body,
                category,
                pinned,
                author: req.adminUser.email,
                authorUserId: req.adminUser._id
            });
            if (!note) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, req.params.ticketId, null, 'admin.support.add_note', reason, { category, pinned });
            return res.status(201).json({ success: true, note });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add support note', details: error.message });
        }
    });

    app.get('/api/admin/support/tickets/:ticketId/flags', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const data = await getTicketFlags(req.params.ticketId);
            if (!data) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            return res.json({ success: true, items: data.items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support flags', details: error.message });
        }
    });

    app.post('/api/admin/support/tickets/:ticketId/flags', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const flag = normalizeString(req.body?.flag);
            const severity = normalizeString(req.body?.severity || 'medium');
            const description = normalizeString(req.body?.description);
            const reason = normalizeReason(req.body?.reason);
            if (!SUPPORT_FLAG_TYPES.includes(flag)) return res.status(400).json({ success: false, error: 'Invalid flag type' });
            if (!SUPPORT_FLAG_SEVERITIES.includes(severity)) return res.status(400).json({ success: false, error: 'Invalid flag severity' });
            const created = await addTicketFlag(req.params.ticketId, {
                flag,
                severity,
                description,
                createdBy: req.adminUser.email,
                createdByUserId: req.adminUser._id
            });
            if (!created) return res.status(404).json({ success: false, error: 'Support ticket not found' });
            await audit(req, req.params.ticketId, null, 'admin.support.flag', reason, { flag, severity });
            return res.status(201).json({ success: true, flag: created });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add support flag', details: error.message });
        }
    });

    app.delete('/api/admin/support/tickets/:ticketId/flags/:flagId', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const reason = normalizeReason(req.body?.reason);
            const removed = await removeTicketFlag(req.params.ticketId, req.params.flagId, req.adminUser._id);
            if (!removed) return res.status(404).json({ success: false, error: 'Support ticket or flag not found' });
            await audit(req, req.params.ticketId, null, 'admin.support.unflag', reason, { flag: removed.flag });
            return res.json({ success: true, removed });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove support flag', details: error.message });
        }
    });

    app.get('/api/admin/support/queues/unassigned', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const data = await getUnassignedQueue(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load unassigned queue', details: error.message });
        }
    });

    app.get('/api/admin/support/queues/escalated', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const data = await getEscalatedQueue(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load escalated queue', details: error.message });
        }
    });

    app.get('/api/admin/support/queues/stale', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const data = await getStaleQueue(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load stale queue', details: error.message });
        }
    });

    app.get('/api/admin/support/queues/by-assignee', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const items = await getWorkloadByAssignee();
            return res.json({ success: true, items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load assignee workload', details: error.message });
        }
    });

    app.get('/api/admin/support/queues/by-team', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const items = await getWorkloadByTeam();
            return res.json({ success: true, items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load team workload', details: error.message });
        }
    });

    app.get('/api/admin/support/teams/:team/tickets', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            if (!SUPPORT_TEAMS.includes(req.params.team)) {
                return res.status(400).json({ success: false, error: 'Invalid support team' });
            }
            const data = await getTeamTickets(req.params.team, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load team tickets', details: error.message });
        }
    });

    app.get('/api/admin/support/agents', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const items = await listSupportAgents();
            return res.json({ success: true, items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load support agents', details: error.message });
        }
    });

    app.get('/api/admin/support/assignees/:adminId/tickets', requireAdminPermission(ADMIN_SUPPORT_PERMISSIONS.VIEW_TICKETS), async (req, res) => {
        try {
            const adminUser = await User.findById(req.params.adminId);
            if (!adminUser || adminUser.role !== 'admin') {
                return res.status(404).json({ success: false, error: 'Admin assignee not found' });
            }
            const data = await getAssigneeTickets(req.params.adminId, req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load assignee tickets', details: error.message });
        }
    });
}

module.exports = registerAdminSupportRoutes;
