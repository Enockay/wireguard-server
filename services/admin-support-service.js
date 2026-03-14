const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const VpnServer = require('../models/VpnServer');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const MonitoringIncident = require('../models/MonitoringIncident');
const AdminAuditLog = require('../models/AdminAuditLog');
const { sendSupportTicketUpdateEmail } = require('./email-service');

const ADMIN_SUPPORT_PERMISSIONS = {
    VIEW: 'admin.support.view',
    VIEW_OVERVIEW: 'admin.support.view_overview',
    VIEW_TICKETS: 'admin.support.view_tickets',
    VIEW_DETAILS: 'admin.support.view_details',
    REPLY: 'admin.support.reply',
    ASSIGN: 'admin.support.assign',
    REASSIGN: 'admin.support.reassign',
    MANAGE_STATUS: 'admin.support.manage_status',
    MANAGE_PRIORITY: 'admin.support.manage_priority',
    ESCALATE: 'admin.support.escalate',
    ADD_INTERNAL_NOTE: 'admin.support.add_internal_note',
    FLAG: 'admin.support.flag',
    VIEW_ANALYTICS: 'admin.support.view_analytics',
    EXPORT: 'admin.support.export'
};

const SUPPORT_NOTE_CATEGORIES = ['support', 'escalation', 'billing', 'networking', 'provisioning', 'security', 'follow_up', 'vip'];
const SUPPORT_FLAG_TYPES = ['vip_customer', 'outage_related', 'billing_related', 'security_related', 'provisioning_issue', 'repeated_issue', 'manual_review', 'urgent_follow_up'];
const SUPPORT_FLAG_SEVERITIES = ['low', 'medium', 'high'];
const STALE_TICKET_HOURS = 72;
const SUPPORT_TEAMS = ['general', 'networking', 'billing', 'security', 'vip', 'operations'];
const SUPPORT_STAFF_ROLES = ['agent', 'manager'];

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function paginate(items, page = 1, limit = 20) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const total = items.length;
    const start = (safePage - 1) * safeLimit;
    return {
        items: items.slice(start, start + safeLimit),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 1
        }
    };
}

function getWindowConfig(window = '30d') {
    const value = String(window || '30d').toLowerCase();
    if (value === '7d') return { key: '7d', ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    if (value === '90d') return { key: '90d', ms: 90 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 };
    return { key: '30d', ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
}

function createTrendBuckets(config) {
    const now = Date.now();
    const start = now - config.ms;
    const buckets = [];
    for (let ts = start; ts <= now; ts += config.bucketMs) {
        buckets.push({
            timestamp: new Date(ts).toISOString(),
            created: 0,
            resolved: 0,
            closed: 0
        });
    }
    return buckets;
}

function addToTrendBuckets(buckets, date, key, bucketMs) {
    if (!date || !buckets.length) return;
    const time = new Date(date).getTime();
    if (Number.isNaN(time)) return;
    const first = new Date(buckets[0].timestamp).getTime();
    const index = Math.floor((time - first) / bucketMs);
    if (index < 0 || index >= buckets.length) return;
    buckets[index][key] += 1;
}

function isOpenStatus(status) {
    return ['open', 'in_progress'].includes(status);
}

function isStale(ticket) {
    if (!isOpenStatus(ticket.status)) return false;
    const updated = new Date(ticket.updatedAt || ticket.createdAt).getTime();
    return Date.now() - updated >= STALE_TICKET_HOURS * 60 * 60 * 1000;
}

function deriveSlaPolicy(priority = 'medium', supportTier = 'standard') {
    const responseMap = { low: 24, medium: 12, high: 4, urgent: 1 };
    const resolutionMap = { low: 120, medium: 72, high: 24, urgent: 8 };
    let firstResponseTargetHours = responseMap[priority] || 12;
    let resolutionTargetHours = resolutionMap[priority] || 72;
    if (supportTier === 'priority') {
        firstResponseTargetHours = Math.max(1, Math.ceil(firstResponseTargetHours / 2));
        resolutionTargetHours = Math.max(4, Math.ceil(resolutionTargetHours / 2));
    }
    if (supportTier === 'vip') {
        firstResponseTargetHours = 1;
        resolutionTargetHours = Math.max(2, Math.ceil(resolutionTargetHours / 3));
    }
    return { firstResponseTargetHours, resolutionTargetHours };
}

function applySlaTargets(ticket, supportTier = 'standard') {
    const createdAt = new Date(ticket.createdAt || Date.now());
    const policy = deriveSlaPolicy(ticket.priority, supportTier);
    ticket.slaPolicy = policy;
    ticket.firstResponseDueAt = new Date(createdAt.getTime() + policy.firstResponseTargetHours * 60 * 60 * 1000);
    ticket.resolutionDueAt = new Date(createdAt.getTime() + policy.resolutionTargetHours * 60 * 60 * 1000);
    return policy;
}

function updateSlaProgress(ticket) {
    const now = Date.now();
    const responseBreached = !ticket.firstResponseAt && ticket.firstResponseDueAt && new Date(ticket.firstResponseDueAt).getTime() < now;
    const resolutionBreached = !ticket.firstResolutionAt && ticket.resolutionDueAt && new Date(ticket.resolutionDueAt).getTime() < now && isOpenStatus(ticket.status);
    ticket.slaBreachedAt = responseBreached || resolutionBreached ? (ticket.slaBreachedAt || new Date()) : null;
}

function getAwaitingState(ticket) {
    if (!isOpenStatus(ticket.status)) return 'inactive';
    if (ticket.lastReplyDirection === 'admin') return 'awaiting_customer';
    return 'awaiting_admin';
}

function buildAgeSummary(ticket) {
    const base = new Date(ticket.createdAt || Date.now()).getTime();
    const updated = new Date(ticket.updatedAt || ticket.createdAt || Date.now()).getTime();
    return {
        ageHours: Math.max(0, Math.round((Date.now() - base) / (60 * 60 * 1000))),
        idleHours: Math.max(0, Math.round((Date.now() - updated) / (60 * 60 * 1000))),
        stale: isStale(ticket)
    };
}

function appendWorkflowEvent(ticket, event) {
    if (!Array.isArray(ticket.workflowEvents)) {
        ticket.workflowEvents = [];
    }
    ticket.workflowEvents.push({
        eventType: event.eventType,
        actorType: event.actorType || 'system',
        actorUserId: event.actorUserId || null,
        summary: event.summary || '',
        metadata: event.metadata || {},
        createdAt: event.createdAt || new Date()
    });
}

function normalizeNote(note) {
    return {
        id: String(note._id),
        body: note.body,
        category: note.category || 'support',
        pinned: Boolean(note.pinned),
        author: note.author || 'system',
        createdAt: note.createdAt
    };
}

function normalizeFlag(flag) {
    return {
        id: String(flag._id),
        flag: flag.flag,
        severity: flag.severity || 'medium',
        description: flag.description || '',
        createdBy: flag.createdBy || 'system',
        createdAt: flag.createdAt
    };
}

function summarizeUser(user) {
    if (!user) return null;
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        supportTier: user.supportTier || 'standard',
        vip: user.supportTier === 'vip'
    };
}

function summarizeAssignee(user) {
    if (!user) return null;
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        supportRole: user.supportRole || 'none',
        supportTeam: user.supportTeam || 'general'
    };
}

function buildSlaSummary(ticket) {
    const responseRemainingMs = ticket.firstResponseAt || !ticket.firstResponseDueAt ? null : (new Date(ticket.firstResponseDueAt).getTime() - Date.now());
    const resolutionRemainingMs = ticket.firstResolutionAt || !ticket.resolutionDueAt ? null : (new Date(ticket.resolutionDueAt).getTime() - Date.now());
    const responseBreached = !ticket.firstResponseAt && ticket.firstResponseDueAt && new Date(ticket.firstResponseDueAt).getTime() < Date.now();
    const resolutionBreached = !ticket.firstResolutionAt && ticket.resolutionDueAt && new Date(ticket.resolutionDueAt).getTime() < Date.now() && isOpenStatus(ticket.status);
    return {
        policy: ticket.slaPolicy || deriveSlaPolicy(ticket.priority, ticket.userId?.supportTier || 'standard'),
        firstResponseDueAt: ticket.firstResponseDueAt || null,
        resolutionDueAt: ticket.resolutionDueAt || null,
        firstResponseAt: ticket.firstResponseAt || null,
        firstResolutionAt: ticket.firstResolutionAt || null,
        responseBreached,
        resolutionBreached,
        breached: responseBreached || resolutionBreached,
        responseRemainingHours: responseRemainingMs === null ? null : Number((responseRemainingMs / (60 * 60 * 1000)).toFixed(2)),
        resolutionRemainingHours: resolutionRemainingMs === null ? null : Number((resolutionRemainingMs / (60 * 60 * 1000)).toFixed(2))
    };
}

async function maybeNotifyCustomer(ticket, payload = {}) {
    try {
        const userId = ticket.userId?._id || ticket.userId;
        if (!userId) return;
        const user = ticket.userId?.email ? ticket.userId : await User.findById(userId).lean();
        if (!user || !user.email) return;
        await sendSupportTicketUpdateEmail(user, {
            ticketSubject: ticket.subject,
            status: ticket.status,
            priority: ticket.priority,
            ...payload
        });
    } catch (_) {
        // Notification failures must not break support workflows.
    }
}

function normalizeMessage(message) {
    return {
        id: String(message._id),
        author: message.userId ? {
            id: String(message.userId._id || message.userId),
            name: message.userId.name || null,
            email: message.userId.email || null
        } : null,
        direction: message.source || 'customer',
        source: message.source || 'customer',
        body: message.message,
        attachments: (message.attachments || []).map((attachment) => ({
            filename: attachment.filename,
            url: attachment.url,
            size: attachment.size,
            contentType: attachment.contentType || null
        })),
        visibility: 'external',
        createdAt: message.createdAt
    };
}

async function buildRelatedContext(ticket) {
    const related = ticket.relatedResources || {};
    const [user, router, server, incident, subscription, transaction, userTickets, userRouters] = await Promise.all([
        User.findById(ticket.userId).lean(),
        related.routerId ? MikrotikRouter.findById(related.routerId).lean() : null,
        related.serverId ? VpnServer.findById(related.serverId).lean() : null,
        related.incidentId ? MonitoringIncident.findById(related.incidentId).lean() : null,
        related.subscriptionId ? Subscription.findById(related.subscriptionId).lean() : null,
        related.transactionId ? Transaction.findById(related.transactionId).lean() : null,
        SupportTicket.countDocuments({ userId: ticket.userId, status: { $in: ['open', 'in_progress'] } }),
        MikrotikRouter.countDocuments({ userId: ticket.userId })
    ]);

    return {
        customer: user ? {
            ...summarizeUser(user),
            openTickets: userTickets,
            routerCount: userRouters,
            accountStatus: user.isActive ? 'active' : 'suspended'
        } : null,
        router: router ? {
            id: String(router._id),
            name: router.name,
            routerId: router.routerId,
            status: router.status,
            vpnIp: router.vpnIp || null
        } : null,
        vpnServer: server ? {
            id: String(server._id),
            name: server.name,
            nodeId: server.nodeId,
            status: server.status
        } : null,
        incident: incident ? {
            id: String(incident._id),
            title: incident.title,
            status: incident.status,
            severity: incident.severity
        } : null,
        subscription: subscription ? {
            id: String(subscription._id),
            status: subscription.status,
            planType: subscription.planType,
            nextBillingDate: subscription.nextBillingDate || null
        } : null,
        transaction: transaction ? {
            id: String(transaction._id),
            transactionId: transaction.transactionId,
            type: transaction.type,
            status: transaction.status,
            amount: transaction.amount
        } : null
    };
}

function buildTicketListItem(ticket) {
    const customer = summarizeUser(ticket.userId);
    const assignee = summarizeAssignee(ticket.assignedTo);
    const related = ticket.relatedResources || {};
    return {
        id: String(ticket._id),
        ticketReference: String(ticket._id),
        subject: ticket.subject,
        customer,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        assignee,
        assignedTeam: ticket.assignedTeam || 'general',
        escalated: Boolean(ticket.escalated),
        escalationState: ticket.escalated ? 'escalated' : 'normal',
        relatedResourceSummary: {
            routerId: related.routerId ? String(related.routerId) : null,
            serverId: related.serverId ? String(related.serverId) : null,
            incidentId: related.incidentId ? String(related.incidentId) : null,
            subscriptionId: related.subscriptionId ? String(related.subscriptionId) : null,
            transactionId: related.transactionId ? String(related.transactionId) : null
        },
        lastReplySummary: {
            at: ticket.lastReplyAt || null,
            direction: ticket.lastReplyDirection || null,
            awaiting: getAwaitingState(ticket)
        },
        age: buildAgeSummary(ticket),
        sla: buildSlaSummary(ticket),
        supportTier: ticket.userId?.supportTier || 'standard',
        vip: ticket.userId?.supportTier === 'vip',
        flags: (ticket.internalFlags || []).map(normalizeFlag),
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt
    };
}

async function loadTicketDocument(ticketId) {
    return SupportTicket.findById(ticketId)
        .populate('userId', 'name email supportTier isActive')
        .populate('assignedTo', 'name email role supportRole supportTeam')
        .populate('reviewedBy', 'name email')
        .populate('messages.userId', 'name email role')
        .populate('internalNotes.authorUserId', 'name email role')
        .populate('workflowEvents.actorUserId', 'name email role');
}

async function loadTicketLean(ticketId) {
    return SupportTicket.findById(ticketId)
        .populate('userId', 'name email supportTier isActive')
        .populate('assignedTo', 'name email role supportRole supportTeam')
        .populate('reviewedBy', 'name email')
        .populate('messages.userId', 'name email role')
        .populate('internalNotes.authorUserId', 'name email role')
        .populate('workflowEvents.actorUserId', 'name email role')
        .lean();
}

async function listTicketDataset() {
    return SupportTicket.find({})
        .populate('userId', 'name email supportTier isActive')
        .populate('assignedTo', 'name email role supportRole supportTeam')
        .sort({ updatedAt: -1 })
        .lean();
}

function filterTickets(tickets, query = {}) {
    const q = String(query.q || '').trim().toLowerCase();
    const from = toDateOrNull(query.createdFrom);
    const to = toDateOrNull(query.createdTo);
    const updatedFrom = toDateOrNull(query.updatedFrom);
    const updatedTo = toDateOrNull(query.updatedTo);

    return tickets.filter((ticket) => {
        if (q) {
            const haystack = [
                String(ticket._id),
                ticket.subject,
                ticket.description,
                ticket.userId?.name,
                ticket.userId?.email,
                ticket.assignedTo?.name,
                ticket.assignedTo?.email,
                ticket.category,
                ticket.priority,
                ticket.status,
                ticket.relatedResources?.routerId ? String(ticket.relatedResources.routerId) : '',
                ticket.relatedResources?.serverId ? String(ticket.relatedResources.serverId) : '',
                ticket.relatedResources?.incidentId ? String(ticket.relatedResources.incidentId) : '',
                ticket.relatedResources?.subscriptionId ? String(ticket.relatedResources.subscriptionId) : '',
                ticket.relatedResources?.transactionId ? String(ticket.relatedResources.transactionId) : ''
            ].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.status && ticket.status !== query.status) return false;
        if (query.priority && ticket.priority !== query.priority) return false;
        if (query.category && ticket.category !== query.category) return false;
        if (query.team && (ticket.assignedTeam || 'general') !== query.team) return false;
        if (query.assignee && String(ticket.assignedTo?._id || ticket.assignedTo || '') !== String(query.assignee)) return false;
        if (String(query.unassigned || '').toLowerCase() === 'true' && ticket.assignedTo) return false;
        if (String(query.escalated || '').toLowerCase() === 'true' && !ticket.escalated) return false;
        if (query.customer && String(ticket.userId?._id || ticket.userId || '') !== String(query.customer)) return false;
        if (query.awaiting === 'admin' && getAwaitingState(ticket) !== 'awaiting_admin') return false;
        if (query.awaiting === 'customer' && getAwaitingState(ticket) !== 'awaiting_customer') return false;
        if (String(query.stale || '').toLowerCase() === 'true' && !isStale(ticket)) return false;
        if (query.linkedResourceType) {
            const related = ticket.relatedResources || {};
            const map = {
                router: related.routerId,
                vpn_server: related.serverId,
                incident: related.incidentId,
                subscription: related.subscriptionId,
                transaction: related.transactionId
            };
            if (!map[query.linkedResourceType]) return false;
        }
        if (query.vip === 'true' && ticket.userId?.supportTier !== 'vip') return false;
        const createdAt = new Date(ticket.createdAt || 0).getTime();
        if (from && createdAt < from.getTime()) return false;
        if (to && createdAt > to.getTime()) return false;
        const updatedAt = new Date(ticket.updatedAt || ticket.createdAt || 0).getTime();
        if (updatedFrom && updatedAt < updatedFrom.getTime()) return false;
        if (updatedTo && updatedAt > updatedTo.getTime()) return false;
        return true;
    });
}

function sortTickets(tickets, sortBy = 'updatedAt', sortOrder = 'desc') {
    const direction = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    return [...tickets].sort((a, b) => {
        if (sortBy === 'createdAt') {
            return direction * (new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
        }
        if (sortBy === 'priority') {
            const rank = { low: 1, medium: 2, high: 3, urgent: 4 };
            return direction * ((rank[a.priority] || 0) - (rank[b.priority] || 0));
        }
        if (sortBy === 'status') {
            return direction * String(a.status || '').localeCompare(String(b.status || ''));
        }
        return direction * (new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime());
    });
}

async function getSupportOverview() {
    const tickets = await listTicketDataset();
    const open = tickets.filter((ticket) => ticket.status === 'open').length;
    const inProgress = tickets.filter((ticket) => ticket.status === 'in_progress').length;
    const pending = 0;
    const resolved = tickets.filter((ticket) => ticket.status === 'resolved').length;
    const closed = tickets.filter((ticket) => ticket.status === 'closed').length;
    const escalated = tickets.filter((ticket) => ticket.escalated).length;
    const unassigned = tickets.filter((ticket) => !ticket.assignedTo).length;
    const highPriority = tickets.filter((ticket) => ['high', 'urgent'].includes(ticket.priority)).length;
    const stale = tickets.filter(isStale).length;
    const slaBreached = tickets.filter((ticket) => buildSlaSummary(ticket).breached).length;
    const awaitingAdminReply = tickets.filter((ticket) => getAwaitingState(ticket) === 'awaiting_admin').length;
    const awaitingCustomerReply = tickets.filter((ticket) => getAwaitingState(ticket) === 'awaiting_customer').length;
    const linkedToIncidents = tickets.filter((ticket) => ticket.relatedResources?.incidentId).length;
    const linkedToBilling = tickets.filter((ticket) => ticket.category === 'billing' || ticket.relatedResources?.subscriptionId || ticket.relatedResources?.transactionId).length;
    const linkedToRouters = tickets.filter((ticket) => ticket.relatedResources?.routerId).length;
    const vipTickets = tickets.filter((ticket) => ticket.userId?.supportTier === 'vip').length;
    return {
        totalTickets: tickets.length,
        openTickets: open + inProgress,
        pendingTickets: pending,
        resolvedTickets: resolved,
        closedTickets: closed,
        escalatedTickets: escalated,
        unassignedTickets: unassigned,
        highPriorityTickets: highPriority,
        staleTickets: stale,
        slaBreachedTickets: slaBreached,
        ticketsLinkedToIncidents: linkedToIncidents,
        ticketsLinkedToBillingIssues: linkedToBilling,
        ticketsLinkedToRouterIssues: linkedToRouters,
        ticketsAwaitingAdminReply: awaitingAdminReply,
        ticketsAwaitingCustomerReply: awaitingCustomerReply,
        vipCustomerTickets: vipTickets,
        lastSupportSyncAt: tickets[0]?.updatedAt || null
    };
}

async function listAdminSupportTickets(query = {}) {
    const filtered = filterTickets(await listTicketDataset(), query);
    const sorted = sortTickets(filtered, query.sortBy, query.sortOrder);
    const items = sorted.map(buildTicketListItem);
    return paginate(items, query.page, query.limit);
}

async function getAdminSupportTicketDetail(ticketId) {
    const ticket = await loadTicketLean(ticketId);
    if (!ticket) return null;
    const context = await buildRelatedContext(ticket);
    const activity = await getAdminSupportTicketActivity(ticketId, { page: 1, limit: 10 });
    return {
        ticket: {
            id: String(ticket._id),
            ticketReference: String(ticket._id),
            subject: ticket.subject,
            description: ticket.description,
            status: ticket.status,
            priority: ticket.priority,
            category: ticket.category,
            escalated: Boolean(ticket.escalated),
            escalationState: ticket.escalated ? 'escalated' : 'normal',
            escalationReason: ticket.escalationReason || '',
            assignee: summarizeAssignee(ticket.assignedTo),
            assignedTeam: ticket.assignedTeam || 'general',
            customer: summarizeUser(ticket.userId),
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt,
            resolvedAt: ticket.resolvedAt || null,
            closedAt: ticket.closedAt || null,
            lastReplyAt: ticket.lastReplyAt || null,
            lastReplyDirection: ticket.lastReplyDirection || null,
            awaitingState: getAwaitingState(ticket),
            age: buildAgeSummary(ticket),
            sla: buildSlaSummary(ticket),
            internalFlags: (ticket.internalFlags || []).map(normalizeFlag),
            internalNotes: (ticket.internalNotes || []).map(normalizeNote).slice(0, 5)
        },
        context,
        recentActivity: activity.items
    };
}

async function getAdminSupportTicketMessages(ticketId, query = {}) {
    const ticket = await SupportTicket.findById(ticketId).populate('messages.userId', 'name email role').lean();
    if (!ticket) return null;
    const messages = (ticket.messages || []).map(normalizeMessage)
        .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
    return paginate(messages, query.page, query.limit);
}

async function getAdminSupportTicketContext(ticketId) {
    const ticket = await SupportTicket.findById(ticketId).populate('userId', 'name email supportTier isActive').lean();
    if (!ticket) return null;
    return buildRelatedContext(ticket);
}

async function getAdminSupportTicketActivity(ticketId, query = {}) {
    const [ticket, audits] = await Promise.all([
        SupportTicket.findById(ticketId)
            .populate('messages.userId', 'name email role')
            .populate('workflowEvents.actorUserId', 'name email role')
            .lean(),
        AdminAuditLog.find({ targetTicketId: ticketId })
            .populate('actorUserId', 'name email role')
            .sort({ createdAt: -1 })
            .lean()
    ]);
    if (!ticket) return null;

    const items = [];
    if ((ticket.workflowEvents || []).length) {
        (ticket.workflowEvents || []).forEach((event) => {
            items.push({
                id: `workflow:${ticket._id}:${event._id}`,
                eventType: event.eventType,
                actor: event.actorUserId ? {
                    id: String(event.actorUserId._id || event.actorUserId),
                    name: event.actorUserId.name || null,
                    email: event.actorUserId.email || null,
                    type: event.actorType
                } : { id: null, name: event.actorType === 'system' ? 'System' : null, email: null, type: event.actorType },
                summary: event.summary || event.eventType,
                metadata: event.metadata || {},
                timestamp: event.createdAt
            });
        });
    } else {
        items.push({
            id: `workflow:${ticket._id}:created`,
            eventType: 'ticket_created',
            actor: summarizeUser(ticket.userId),
            summary: 'Support ticket created',
            metadata: { category: ticket.category, priority: ticket.priority },
            timestamp: ticket.createdAt
        });
    }

    audits.forEach((audit) => {
        items.push({
            id: `audit:${audit._id}`,
            eventType: audit.action,
            actor: audit.actorUserId ? {
                id: String(audit.actorUserId._id || audit.actorUserId),
                name: audit.actorUserId.name || null,
                email: audit.actorUserId.email || null,
                type: 'admin'
            } : { id: null, name: 'Admin', email: null, type: 'admin' },
            summary: audit.reason || audit.action,
            metadata: audit.metadata || {},
            timestamp: audit.createdAt
        });
    });

    const filtered = items
        .filter((item) => {
            const from = toDateOrNull(query.from);
            const to = toDateOrNull(query.to);
            if (query.eventType && item.eventType !== query.eventType) return false;
            const ts = new Date(item.timestamp || 0).getTime();
            if (from && ts < from.getTime()) return false;
            if (to && ts > to.getTime()) return false;
            return true;
        })
        .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    return paginate(filtered, query.page, query.limit);
}

async function getSupportAnalytics(query = {}) {
    const tickets = await listTicketDataset();
    const config = getWindowConfig(query.window);
    const buckets = createTrendBuckets(config);
    tickets.forEach((ticket) => {
        addToTrendBuckets(buckets, ticket.createdAt, 'created', config.bucketMs);
        addToTrendBuckets(buckets, ticket.resolvedAt, 'resolved', config.bucketMs);
        addToTrendBuckets(buckets, ticket.closedAt, 'closed', config.bucketMs);
    });

    const byCategory = {};
    const byPriority = {};
    const byAssignee = {};
    const byTeam = {};
    tickets.forEach((ticket) => {
        byCategory[ticket.category] = (byCategory[ticket.category] || 0) + 1;
        byPriority[ticket.priority] = (byPriority[ticket.priority] || 0) + 1;
        const assigneeKey = ticket.assignedTo ? String(ticket.assignedTo._id || ticket.assignedTo) : 'unassigned';
        const assigneeLabel = ticket.assignedTo?.name || 'Unassigned';
        if (!byAssignee[assigneeKey]) byAssignee[assigneeKey] = { assigneeId: assigneeKey === 'unassigned' ? null : assigneeKey, assigneeName: assigneeLabel, count: 0 };
        byAssignee[assigneeKey].count += 1;
        const teamKey = ticket.assignedTeam || 'general';
        byTeam[teamKey] = (byTeam[teamKey] || 0) + 1;
    });

    const resolvedTickets = tickets.filter((ticket) => ticket.resolvedAt || ticket.closedAt);
    const resolutionHours = resolvedTickets
        .map((ticket) => ((new Date(ticket.resolvedAt || ticket.closedAt).getTime() - new Date(ticket.createdAt).getTime()) / (60 * 60 * 1000)))
        .filter((hours) => Number.isFinite(hours) && hours >= 0);
    const firstResponseHours = tickets
        .filter((ticket) => ticket.firstResponseAt)
        .map((ticket) => ((new Date(ticket.firstResponseAt).getTime() - new Date(ticket.createdAt).getTime()) / (60 * 60 * 1000)))
        .filter((hours) => Number.isFinite(hours) && hours >= 0);

    return {
        window: config.key,
        trends: buckets,
        totals: {
            created: tickets.length,
            resolved: resolvedTickets.length,
            openBacklog: tickets.filter((ticket) => isOpenStatus(ticket.status)).length
        },
        averageResolutionHours: resolutionHours.length
            ? Number((resolutionHours.reduce((sum, value) => sum + value, 0) / resolutionHours.length).toFixed(2))
            : null,
        averageFirstResponseHours: firstResponseHours.length
            ? Number((firstResponseHours.reduce((sum, value) => sum + value, 0) / firstResponseHours.length).toFixed(2))
            : null,
        ticketsByCategory: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
        ticketsByPriority: Object.entries(byPriority).map(([priority, count]) => ({ priority, count })),
        ticketsByAssignee: Object.values(byAssignee).sort((a, b) => b.count - a.count),
        ticketsByTeam: Object.entries(byTeam).map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count)
    };
}

async function getTicketNotes(ticketId) {
    const ticket = await SupportTicket.findById(ticketId).lean();
    if (!ticket) return null;
    return {
        items: (ticket.internalNotes || []).map(normalizeNote).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    };
}

async function addTicketNote(ticketId, { body, category = 'support', pinned = false, author, authorUserId }) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    ticket.internalNotes.push({ body, category, pinned: Boolean(pinned), author, authorUserId });
    appendWorkflowEvent(ticket, {
        eventType: 'internal_note_added',
        actorType: 'admin',
        actorUserId,
        summary: 'Internal support note added',
        metadata: { category, pinned: Boolean(pinned) }
    });
    await ticket.save();
    return normalizeNote(ticket.internalNotes[ticket.internalNotes.length - 1]);
}

async function getTicketFlags(ticketId) {
    const ticket = await SupportTicket.findById(ticketId).lean();
    if (!ticket) return null;
    return {
        items: (ticket.internalFlags || []).map(normalizeFlag).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    };
}

async function addTicketFlag(ticketId, { flag, severity = 'medium', description = '', createdBy, createdByUserId }) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    ticket.internalFlags.push({ flag, severity, description, createdBy, createdByUserId });
    appendWorkflowEvent(ticket, {
        eventType: 'flag_added',
        actorType: 'admin',
        actorUserId: createdByUserId,
        summary: 'Support ticket flag added',
        metadata: { flag, severity }
    });
    await ticket.save();
    return normalizeFlag(ticket.internalFlags[ticket.internalFlags.length - 1]);
}

async function removeTicketFlag(ticketId, flagId, actorUserId = null) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const flag = ticket.internalFlags.id(flagId);
    if (!flag) return false;
    const removed = normalizeFlag(flag);
    flag.deleteOne();
    appendWorkflowEvent(ticket, {
        eventType: 'flag_removed',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket flag removed',
        metadata: { flag: removed.flag }
    });
    await ticket.save();
    return removed;
}

async function assignTicket(ticketId, assigneeId, actorUserId) {
    const [ticket, assignee] = await Promise.all([loadTicketDocument(ticketId), User.findById(assigneeId)]);
    if (!ticket || !assignee || assignee.role !== 'admin') return null;
    const previousAssignee = summarizeAssignee(ticket.assignedTo);
    ticket.assignedTo = assignee._id;
    ticket.assignedAt = new Date();
    ticket.assignedTeam = assignee.supportTeam || ticket.assignedTeam || 'general';
    appendWorkflowEvent(ticket, {
        eventType: previousAssignee ? 'ticket_reassigned' : 'ticket_assigned',
        actorType: 'admin',
        actorUserId,
        summary: previousAssignee ? 'Support ticket reassigned' : 'Support ticket assigned',
        metadata: { from: previousAssignee, to: summarizeAssignee(assignee), team: ticket.assignedTeam }
    });
    await ticket.save();
    return {
        ticket,
        assignee: summarizeAssignee(assignee),
        previousAssignee
    };
}

async function unassignTicket(ticketId, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const previousAssignee = summarizeAssignee(ticket.assignedTo);
    ticket.assignedTo = undefined;
    ticket.assignedTeam = 'general';
    appendWorkflowEvent(ticket, {
        eventType: 'ticket_unassigned',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket unassigned',
        metadata: { from: previousAssignee }
    });
    await ticket.save();
    return { ticket, previousAssignee };
}

async function updateTicketStatus(ticketId, status, actorUserId, summary) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const previousStatus = ticket.status;
    ticket.status = status;
    if (status === 'resolved') {
        ticket.resolvedAt = new Date();
        if (!ticket.firstResolutionAt) ticket.firstResolutionAt = ticket.resolvedAt;
    }
    if (status === 'closed') ticket.closedAt = new Date();
    if (status === 'open' || status === 'in_progress') {
        ticket.closedAt = null;
        if (status === 'open') ticket.resolvedAt = null;
    }
    appendWorkflowEvent(ticket, {
        eventType: 'status_changed',
        actorType: 'admin',
        actorUserId,
        summary: summary || `Ticket status changed to ${status}`,
        metadata: { from: previousStatus, to: status }
    });
    updateSlaProgress(ticket);
    await ticket.save();
    await maybeNotifyCustomer(ticket, {
        intro: `Your support ticket status changed from ${previousStatus} to ${status}.`,
        message: summary || `Support ticket status changed to ${status}.`
    });
    return { ticket, previousStatus, status };
}

async function changeTicketPriority(ticketId, priority, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const previousPriority = ticket.priority;
    ticket.priority = priority;
    applySlaTargets(ticket, ticket.userId?.supportTier || 'standard');
    updateSlaProgress(ticket);
    appendWorkflowEvent(ticket, {
        eventType: 'priority_changed',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket priority updated',
        metadata: { from: previousPriority, to: priority }
    });
    await ticket.save();
    return { ticket, previousPriority, priority };
}

async function changeTicketCategory(ticketId, category, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const previousCategory = ticket.category;
    ticket.category = category;
    if (!ticket.assignedTo) {
        ticket.assignedTeam = category === 'billing' ? 'billing' : (category === 'technical' ? 'networking' : ticket.assignedTeam || 'general');
    }
    appendWorkflowEvent(ticket, {
        eventType: 'category_changed',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket category updated',
        metadata: { from: previousCategory, to: category }
    });
    await ticket.save();
    return { ticket, previousCategory, category };
}

async function escalateTicket(ticketId, reason, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    ticket.escalated = true;
    ticket.escalatedAt = new Date();
    ticket.escalationReason = reason || '';
    appendWorkflowEvent(ticket, {
        eventType: 'ticket_escalated',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket escalated',
        metadata: { reason: reason || '' }
    });
    await ticket.save();
    return ticket;
}

async function deescalateTicket(ticketId, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    ticket.escalated = false;
    ticket.escalatedAt = null;
    ticket.escalationReason = '';
    appendWorkflowEvent(ticket, {
        eventType: 'ticket_deescalated',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket de-escalated',
        metadata: {}
    });
    await ticket.save();
    return ticket;
}

async function replyToTicket(ticketId, { userId, message, attachments = [] }) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    if (ticket.status === 'closed') return false;
    ticket.messages.push({ userId, message, attachments, source: 'admin' });
    ticket.lastReplyAt = new Date();
    ticket.lastReplyDirection = 'admin';
    if (!ticket.firstResponseAt) {
        ticket.firstResponseAt = ticket.lastReplyAt;
    }
    if (ticket.status === 'open') {
        ticket.status = 'in_progress';
    }
    appendWorkflowEvent(ticket, {
        eventType: 'admin_reply_added',
        actorType: 'admin',
        actorUserId: userId,
        summary: 'Admin replied to support ticket',
        metadata: { attachmentCount: attachments.length }
    });
    updateSlaProgress(ticket);
    await ticket.save();
    await maybeNotifyCustomer(ticket, {
        intro: 'A support agent replied to your ticket.',
        message
    });
    return ticket;
}

async function markTicketReviewed(ticketId, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    ticket.lastReviewedAt = new Date();
    ticket.reviewedBy = actorUserId;
    appendWorkflowEvent(ticket, {
        eventType: 'ticket_reviewed',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket reviewed',
        metadata: {}
    });
    await ticket.save();
    return ticket;
}

async function updateTicketContext(ticketId, context, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const before = { ...(ticket.relatedResources?.toObject ? ticket.relatedResources.toObject() : ticket.relatedResources || {}) };
    ticket.relatedResources = {
        ...before,
        ...(context.routerId !== undefined ? { routerId: context.routerId || null } : {}),
        ...(context.serverId !== undefined ? { serverId: context.serverId || null } : {}),
        ...(context.incidentId !== undefined ? { incidentId: context.incidentId || null } : {}),
        ...(context.subscriptionId !== undefined ? { subscriptionId: context.subscriptionId || null } : {}),
        ...(context.transactionId !== undefined ? { transactionId: context.transactionId || null } : {})
    };
    appendWorkflowEvent(ticket, {
        eventType: 'context_updated',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket related context updated',
        metadata: { before, after: ticket.relatedResources }
    });
    await ticket.save();
    return { ticket, before, after: ticket.relatedResources };
}

async function getUnassignedQueue(query = {}) {
    return listAdminSupportTickets({ ...query, unassigned: true });
}

async function getEscalatedQueue(query = {}) {
    return listAdminSupportTickets({ ...query, escalated: true });
}

async function getStaleQueue(query = {}) {
    return listAdminSupportTickets({ ...query, stale: true });
}

async function getWorkloadByAssignee() {
    const tickets = await listTicketDataset();
    const workload = new Map();
    tickets.forEach((ticket) => {
        const key = ticket.assignedTo ? String(ticket.assignedTo._id || ticket.assignedTo) : 'unassigned';
        if (!workload.has(key)) {
            workload.set(key, {
                assignee: ticket.assignedTo ? summarizeAssignee(ticket.assignedTo) : null,
                totalTickets: 0,
                openTickets: 0,
                escalatedTickets: 0,
                highPriorityTickets: 0,
                staleTickets: 0,
                slaBreachedTickets: 0
            });
        }
        const row = workload.get(key);
        row.totalTickets += 1;
        if (isOpenStatus(ticket.status)) row.openTickets += 1;
        if (ticket.escalated) row.escalatedTickets += 1;
        if (['high', 'urgent'].includes(ticket.priority)) row.highPriorityTickets += 1;
        if (isStale(ticket)) row.staleTickets += 1;
        if (buildSlaSummary(ticket).breached) row.slaBreachedTickets += 1;
    });
    return Array.from(workload.values()).sort((a, b) => b.openTickets - a.openTickets);
}

async function getAssigneeTickets(adminId, query = {}) {
    return listAdminSupportTickets({ ...query, assignee: adminId });
}

async function assignTicketTeam(ticketId, team, actorUserId) {
    const ticket = await loadTicketDocument(ticketId);
    if (!ticket) return null;
    const previousTeam = ticket.assignedTeam || 'general';
    ticket.assignedTeam = team;
    appendWorkflowEvent(ticket, {
        eventType: 'team_assigned',
        actorType: 'admin',
        actorUserId,
        summary: 'Support ticket team updated',
        metadata: { from: previousTeam, to: team }
    });
    await ticket.save();
    return { ticket, previousTeam, team };
}

async function getWorkloadByTeam() {
    const tickets = await listTicketDataset();
    const workload = new Map();
    tickets.forEach((ticket) => {
        const key = ticket.assignedTeam || 'general';
        if (!workload.has(key)) {
            workload.set(key, {
                team: key,
                totalTickets: 0,
                openTickets: 0,
                escalatedTickets: 0,
                staleTickets: 0,
                slaBreachedTickets: 0
            });
        }
        const row = workload.get(key);
        row.totalTickets += 1;
        if (isOpenStatus(ticket.status)) row.openTickets += 1;
        if (ticket.escalated) row.escalatedTickets += 1;
        if (isStale(ticket)) row.staleTickets += 1;
        if (buildSlaSummary(ticket).breached) row.slaBreachedTickets += 1;
    });
    return SUPPORT_TEAMS.map((team) => workload.get(team) || {
        team,
        totalTickets: 0,
        openTickets: 0,
        escalatedTickets: 0,
        staleTickets: 0,
        slaBreachedTickets: 0
    });
}

async function getTeamTickets(team, query = {}) {
    return listAdminSupportTickets({ ...query, team });
}

async function listSupportAgents() {
    const users = await User.find({ role: 'admin', supportRole: { $in: SUPPORT_STAFF_ROLES } }, 'name email supportRole supportTeam').lean();
    return users.map((user) => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        supportRole: user.supportRole || 'none',
        supportTeam: user.supportTeam || 'general'
    }));
}

module.exports = {
    ADMIN_SUPPORT_PERMISSIONS,
    SUPPORT_NOTE_CATEGORIES,
    SUPPORT_FLAG_TYPES,
    SUPPORT_FLAG_SEVERITIES,
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
    listSupportAgents,
    SUPPORT_TEAMS,
    SUPPORT_STAFF_ROLES,
    deriveSlaPolicy,
    applySlaTargets
};
