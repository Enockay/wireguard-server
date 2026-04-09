const mongoose = require('mongoose');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const VpnServer = require('../models/VpnServer');
const SupportTicket = require('../models/SupportTicket');
const MonitoringIncident = require('../models/MonitoringIncident');
const ServicePlan = require('../models/ServicePlan');
const Reseller = require('../models/Reseller');
const AdminNotificationState = require('../models/AdminNotificationState');
const { requireAdmin } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');

const ADMIN_ROLE_VALUES = ['super_admin', 'network_admin', 'billing_admin', 'support_admin', 'read_only'];
const SEARCH_LIMIT = 6;

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function normalizeString(value) {
    return value ? String(value).trim() : '';
}

function normalizeNullableString(value) {
    if (value === undefined) return undefined;
    const normalized = normalizeString(value);
    return normalized || null;
}

function normalizeNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureObjectIdArray(values = []) {
    if (!Array.isArray(values)) return [];
    return values
        .map((value) => String(value || '').trim())
        .filter((value) => mongoose.Types.ObjectId.isValid(value));
}

function serializeAdmin(user) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        adminRole: user.adminRole || null,
        isActive: Boolean(user.isActive),
        lastLoginAt: user.lastLoginAt || null,
        createdAt: user.createdAt
    };
}

function serializeReseller(reseller, related = {}) {
    const assignedUsers = Array.isArray(related.users) ? related.users : [];
    const assignedRouters = Array.isArray(related.routers) ? related.routers : [];
    const assignedPlans = Array.isArray(related.plans) ? related.plans : [];
    return {
        id: String(reseller._id),
        name: reseller.name,
        code: reseller.code,
        companyName: reseller.companyName || '',
        contactName: reseller.contactName || '',
        contactEmail: reseller.contactEmail || '',
        contactPhone: reseller.contactPhone || '',
        status: reseller.status || 'inactive',
        territory: reseller.territory || '',
        commissionRate: Number(reseller.commissionRate || 0),
        priceOverridePercent: Number(reseller.priceOverridePercent || 0),
        notes: reseller.notes || '',
        payoutBalance: Number(reseller.payoutBalance || 0),
        totalPaidOut: Number(reseller.totalPaidOut || 0),
        lastPayoutAt: reseller.lastPayoutAt || null,
        lastPayoutReference: reseller.lastPayoutReference || '',
        assignedUsers: assignedUsers.map((user) => ({
            id: String(user._id),
            name: user.name,
            email: user.email,
            company: user.company || ''
        })),
        assignedRouters: assignedRouters.map((router) => ({
            id: String(router._id),
            name: router.name,
            routerId: router.routerId,
            status: router.status || 'unknown',
            vpnIp: router.vpnIp || null
        })),
        assignedPlans: assignedPlans.map((plan) => ({
            id: String(plan._id),
            name: plan.name,
            planType: plan.planType,
            price: Number(plan.price || 0),
            currency: plan.currency || 'USD',
            isActive: Boolean(plan.isActive)
        })),
        summary: {
            assignedUsers: assignedUsers.length,
            assignedRouters: assignedRouters.length,
            assignedPlans: assignedPlans.length
        },
        createdBy: reseller.createdBy || 'system',
        createdAt: reseller.createdAt,
        updatedAt: reseller.updatedAt
    };
}

function canManageAdmins(adminUser) {
    return adminUser?.adminRole === 'super_admin' || !adminUser?.adminRole;
}

async function audit(req, targetUserId, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId,
        action,
        reason,
        metadata
    });
}

async function auditSystem(req, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        action,
        reason,
        metadata
    });
}

function buildResellerPayload(body = {}) {
    const name = normalizeString(body.name);
    const code = normalizeString(body.code).toUpperCase();
    if (!name || !code) {
        return null;
    }

    return {
        name,
        code,
        companyName: normalizeString(body.companyName),
        contactName: normalizeString(body.contactName),
        contactEmail: normalizeString(body.contactEmail).toLowerCase(),
        contactPhone: normalizeString(body.contactPhone),
        territory: normalizeString(body.territory),
        status: String(body.status || 'active') === 'inactive' ? 'inactive' : 'active',
        commissionRate: Math.max(0, Math.min(100, normalizeNumber(body.commissionRate, 0))),
        priceOverridePercent: Math.max(-100, Math.min(100, normalizeNumber(body.priceOverridePercent, 0))),
        notes: normalizeString(body.notes),
        payoutBalance: normalizeNumber(body.payoutBalance, 0),
        totalPaidOut: Math.max(0, normalizeNumber(body.totalPaidOut, 0)),
        lastPayoutReference: normalizeString(body.lastPayoutReference),
        assignedUserIds: ensureObjectIdArray(body.assignedUserIds),
        assignedRouterIds: ensureObjectIdArray(body.assignedRouterIds),
        assignedPlanIds: ensureObjectIdArray(body.assignedPlanIds)
    };
}

async function hydrateReseller(reseller) {
    const [users, routers, plans] = await Promise.all([
        reseller.assignedUserIds?.length ? User.find({ _id: { $in: reseller.assignedUserIds } }).select('name email company').lean() : [],
        reseller.assignedRouterIds?.length ? MikrotikRouter.find({ _id: { $in: reseller.assignedRouterIds } }).select('name routerId status vpnIp').lean() : [],
        reseller.assignedPlanIds?.length ? ServicePlan.find({ _id: { $in: reseller.assignedPlanIds } }).select('name planType price currency isActive').lean() : []
    ]);
    return serializeReseller(reseller, { users, routers, plans });
}

function buildNotificationLink(type, id) {
    switch (type) {
        case 'incident':
            return '/monitoring/incidents-alerts';
        case 'ticket':
            return `/support/tickets/${id}`;
        case 'router':
            return `/routers/${id}`;
        default:
            return '/dashboard';
    }
}

async function buildNotifications(adminUser) {
    const [incidents, escalatedTickets, staleTickets, offlineRouters] = await Promise.all([
        MonitoringIncident.find({ status: { $in: ['open', 'acknowledged'] } })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('title severity status createdAt')
            .lean(),
        SupportTicket.find({ escalated: true, status: { $in: ['open', 'in_progress'] } })
            .sort({ updatedAt: -1 })
            .limit(5)
            .select('subject priority updatedAt')
            .lean(),
        SupportTicket.find({ status: { $in: ['open', 'in_progress'] }, updatedAt: { $lte: new Date(Date.now() - 72 * 60 * 60 * 1000) } })
            .sort({ updatedAt: 1 })
            .limit(5)
            .select('subject priority updatedAt')
            .lean(),
        MikrotikRouter.find({ status: 'offline' })
            .sort({ updatedAt: -1 })
            .limit(5)
            .select('name vpnIp updatedAt')
            .lean()
    ]);

    const state = await AdminNotificationState.findOneAndUpdate(
        { adminUserId: adminUser._id },
        { $setOnInsert: { readNotificationIds: [] } },
        { new: true, upsert: true }
    );
    const readIds = new Set(state.readNotificationIds || []);

    const items = [
        ...incidents.map((incident) => ({
            id: `incident:${incident._id}`,
            category: 'incident',
            title: incident.title || 'Open incident',
            body: `${incident.severity || 'medium'} severity incident still requires attention.`,
            tone: incident.severity === 'critical' ? 'danger' : 'warning',
            href: buildNotificationLink('incident', String(incident._id)),
            createdAt: incident.createdAt,
            read: readIds.has(`incident:${incident._id}`)
        })),
        ...escalatedTickets.map((ticket) => ({
            id: `ticket:${ticket._id}:escalated`,
            category: 'support',
            title: ticket.subject || 'Escalated support ticket',
            body: `Escalated support issue with ${ticket.priority || 'medium'} priority.`,
            tone: 'warning',
            href: buildNotificationLink('ticket', String(ticket._id)),
            createdAt: ticket.updatedAt,
            read: readIds.has(`ticket:${ticket._id}:escalated`)
        })),
        ...staleTickets.map((ticket) => ({
            id: `ticket:${ticket._id}:stale`,
            category: 'support',
            title: ticket.subject || 'Stale support ticket',
            body: 'This support ticket has gone stale and likely needs follow-up.',
            tone: 'info',
            href: buildNotificationLink('ticket', String(ticket._id)),
            createdAt: ticket.updatedAt,
            read: readIds.has(`ticket:${ticket._id}:stale`)
        })),
        ...offlineRouters.map((router) => ({
            id: `router:${router._id}:offline`,
            category: 'router',
            title: router.name || 'Router offline',
            body: `Router ${router.vpnIp || 'without a VPN IP'} is still offline.`,
            tone: 'danger',
            href: buildNotificationLink('router', String(router._id)),
            createdAt: router.updatedAt,
            read: readIds.has(`router:${router._id}:offline`)
        }))
    ]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20);

    return {
        items,
        unreadCount: items.filter((item) => !item.read).length
    };
}

function registerAdminManagementRoutes(app) {
    app.get('/api/admin/resellers', requireAdmin, async (req, res) => {
        try {
            const q = normalizeString(req.query?.q);
            const status = normalizeString(req.query?.status);
            const query = {};
            if (q) {
                const pattern = new RegExp(escapeRegex(q), 'i');
                query.$or = [
                    { name: pattern },
                    { code: pattern },
                    { companyName: pattern },
                    { contactName: pattern },
                    { contactEmail: pattern },
                    { territory: pattern }
                ];
            }
            if (['active', 'inactive'].includes(status)) {
                query.status = status;
            }

            const resellers = await Reseller.find(query).sort({ createdAt: -1 });
            const items = await Promise.all(resellers.map((reseller) => hydrateReseller(reseller)));
            return res.json({ success: true, items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load resellers', details: error.message });
        }
    });

    app.post('/api/admin/resellers', requireAdmin, async (req, res) => {
        try {
            const payload = buildResellerPayload(req.body || {});
            if (!payload) {
                return res.status(400).json({ success: false, error: 'name and code are required' });
            }
            const duplicate = await Reseller.findOne({ $or: [{ code: payload.code }, { name: payload.name }] }).lean();
            if (duplicate) {
                return res.status(409).json({ success: false, error: 'A reseller with that name or code already exists' });
            }

            const reseller = await Reseller.create({
                ...payload,
                createdBy: req.adminUser.email || req.adminUser.name || 'system'
            });
            await auditSystem(req, 'admin_create_reseller', normalizeReason(req.body?.reason), { resellerId: reseller._id, code: reseller.code });
            return res.status(201).json({
                success: true,
                message: 'Reseller created successfully',
                reseller: await hydrateReseller(reseller)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create reseller', details: error.message });
        }
    });

    app.put('/api/admin/resellers/:id', requireAdmin, async (req, res) => {
        try {
            const reseller = await Reseller.findById(req.params.id);
            if (!reseller) {
                return res.status(404).json({ success: false, error: 'Reseller not found' });
            }
            const payload = buildResellerPayload({ ...reseller.toObject(), ...req.body });
            if (!payload) {
                return res.status(400).json({ success: false, error: 'name and code are required' });
            }
            const duplicate = await Reseller.findOne({
                _id: { $ne: reseller._id },
                $or: [{ code: payload.code }, { name: payload.name }]
            }).lean();
            if (duplicate) {
                return res.status(409).json({ success: false, error: 'A reseller with that name or code already exists' });
            }

            Object.assign(reseller, payload);
            if (req.body?.lastPayoutAt !== undefined) {
                reseller.lastPayoutAt = req.body?.lastPayoutAt ? new Date(req.body.lastPayoutAt) : null;
            }
            await reseller.save();
            await auditSystem(req, 'admin_update_reseller', normalizeReason(req.body?.reason), {
                resellerId: reseller._id,
                fields: Object.keys(req.body || {}).filter((field) => field !== 'reason')
            });
            return res.json({
                success: true,
                message: 'Reseller updated successfully',
                reseller: await hydrateReseller(reseller)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update reseller', details: error.message });
        }
    });

    app.post('/api/admin/resellers/:id/activate', requireAdmin, async (req, res) => {
        try {
            const reseller = await Reseller.findById(req.params.id);
            if (!reseller) {
                return res.status(404).json({ success: false, error: 'Reseller not found' });
            }
            reseller.status = 'active';
            await reseller.save();
            await auditSystem(req, 'admin_activate_reseller', normalizeReason(req.body?.reason), { resellerId: reseller._id });
            return res.json({ success: true, message: 'Reseller activated', reseller: await hydrateReseller(reseller) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to activate reseller', details: error.message });
        }
    });

    app.post('/api/admin/resellers/:id/deactivate', requireAdmin, async (req, res) => {
        try {
            const reseller = await Reseller.findById(req.params.id);
            if (!reseller) {
                return res.status(404).json({ success: false, error: 'Reseller not found' });
            }
            reseller.status = 'inactive';
            await reseller.save();
            await auditSystem(req, 'admin_deactivate_reseller', normalizeReason(req.body?.reason), { resellerId: reseller._id });
            return res.json({ success: true, message: 'Reseller deactivated', reseller: await hydrateReseller(reseller) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to deactivate reseller', details: error.message });
        }
    });

    app.delete('/api/admin/resellers/:id', requireAdmin, async (req, res) => {
        try {
            const reseller = await Reseller.findById(req.params.id);
            if (!reseller) {
                return res.status(404).json({ success: false, error: 'Reseller not found' });
            }
            await Reseller.deleteOne({ _id: reseller._id });
            await auditSystem(req, 'admin_delete_reseller', normalizeReason(req.body?.reason), { resellerId: reseller._id, code: reseller.code });
            return res.json({ success: true, message: 'Reseller deleted' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete reseller', details: error.message });
        }
    });

    app.get('/api/admin/search', requireAdmin, async (req, res) => {
        try {
            const q = normalizeString(req.query?.q);
            if (!q || q.length < 2) {
                return res.json({ success: true, items: [] });
            }
            const pattern = new RegExp(escapeRegex(q), 'i');
            const [users, routers, tickets, servers] = await Promise.all([
                User.find({ role: 'user', $or: [{ name: pattern }, { email: pattern }, { company: pattern }] })
                    .select('name email company')
                    .limit(SEARCH_LIMIT)
                    .lean(),
                MikrotikRouter.find({ $or: [{ name: pattern }, { routerId: pattern }, { vpnIp: pattern }] })
                    .select('name routerId vpnIp status')
                    .limit(SEARCH_LIMIT)
                    .lean(),
                SupportTicket.find({ $or: [{ subject: pattern }, { description: pattern }] })
                    .select('subject status priority')
                    .limit(SEARCH_LIMIT)
                    .lean(),
                VpnServer.find({ $or: [{ name: pattern }, { nodeId: pattern }, { region: pattern }, { hostname: pattern }] })
                    .select('name nodeId region status')
                    .limit(SEARCH_LIMIT)
                    .lean()
            ]);
            const items = [
                ...users.map((user) => ({
                    id: `user:${user._id}`,
                    type: 'user',
                    resourceId: String(user._id),
                    title: user.name,
                    subtitle: user.email,
                    meta: user.company || 'Subscriber',
                    href: `/users/${user._id}`
                })),
                ...routers.map((router) => ({
                    id: `router:${router._id}`,
                    type: 'router',
                    resourceId: String(router._id),
                    title: router.name,
                    subtitle: router.routerId || router.vpnIp || 'Router',
                    meta: router.status || 'unknown',
                    href: `/routers/${router._id}`
                })),
                ...tickets.map((ticket) => ({
                    id: `ticket:${ticket._id}`,
                    type: 'ticket',
                    resourceId: String(ticket._id),
                    title: ticket.subject,
                    subtitle: `${ticket.priority || 'medium'} priority`,
                    meta: ticket.status || 'open',
                    href: `/support/tickets/${ticket._id}`
                })),
                ...servers.map((server) => ({
                    id: `vpn_server:${server._id}`,
                    type: 'vpn_server',
                    resourceId: String(server._id),
                    title: server.name,
                    subtitle: server.nodeId || server.region || 'VPN server',
                    meta: server.status || 'unknown',
                    href: `/vpn-servers/${server._id}`
                }))
            ];
            return res.json({ success: true, items: items.slice(0, 20) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to perform admin search', details: error.message });
        }
    });

    app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
        try {
            const payload = await buildNotifications(req.adminUser);
            return res.json({ success: true, ...payload });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load notifications', details: error.message });
        }
    });

    app.post('/api/admin/notifications/:id/read', requireAdmin, async (req, res) => {
        try {
            const notificationId = String(req.params.id || '').trim();
            if (!notificationId) {
                return res.status(400).json({ success: false, error: 'Notification id is required' });
            }
            const state = await AdminNotificationState.findOneAndUpdate(
                { adminUserId: req.adminUser._id },
                { $addToSet: { readNotificationIds: notificationId } },
                { new: true, upsert: true }
            );
            return res.json({ success: true, message: 'Notification marked as read', count: state.readNotificationIds.length });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update notification state', details: error.message });
        }
    });

    app.post('/api/admin/notifications/read-all', requireAdmin, async (req, res) => {
        try {
            const payload = await buildNotifications(req.adminUser);
            await AdminNotificationState.findOneAndUpdate(
                { adminUserId: req.adminUser._id },
                {
                    $set: {
                        readAllAt: new Date(),
                        readNotificationIds: payload.items.map((item) => item.id)
                    }
                },
                { new: true, upsert: true }
            );
            return res.json({ success: true, message: 'All notifications marked as read' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark notifications as read', details: error.message });
        }
    });

    app.get('/api/admin/management/admins', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admins = await User.find({ role: 'admin' })
                .select('name email adminRole isActive lastLoginAt createdAt')
                .sort({ createdAt: -1 })
                .lean();

            return res.json({
                success: true,
                items: admins.map((admin) => serializeAdmin(admin))
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load admin accounts', details: error.message });
        }
    });

    app.post('/api/admin/management/admins', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const name = String(req.body?.name || '').trim();
            const email = String(req.body?.email || '').trim().toLowerCase();
            const password = String(req.body?.password || '');
            const adminRole = String(req.body?.adminRole || '').trim();

            if (!name || !email || password.length < 6 || !ADMIN_ROLE_VALUES.includes(adminRole)) {
                return res.status(400).json({ success: false, error: 'name, email, password (min 6 chars), and a valid adminRole are required' });
            }

            const existingUser = await User.findOne({ email });
            if (existingUser) {
                return res.status(409).json({ success: false, error: 'An account with this email already exists' });
            }

            const admin = await User.create({
                name,
                email,
                password,
                role: 'admin',
                adminRole,
                isActive: true,
                emailVerified: true,
                emailVerifiedAt: new Date()
            });

            await audit(req, admin._id, 'admin_create_admin_account', normalizeReason(req.body?.reason), {
                email: admin.email,
                adminRole: admin.adminRole
            });

            return res.status(201).json({ success: true, admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create admin account', details: error.message });
        }
    });

    app.put('/api/admin/management/admins/:id', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            if (String(admin._id) === String(req.adminUser._id) && Object.prototype.hasOwnProperty.call(req.body || {}, 'adminRole')) {
                return res.status(403).json({ success: false, error: 'You cannot change your own role' });
            }

            const changed = {};
            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
                const nextName = String(req.body?.name || '').trim();
                if (!nextName) {
                    return res.status(400).json({ success: false, error: 'Name cannot be empty' });
                }
                admin.name = nextName;
                changed.name = nextName;
            }

            if (Object.prototype.hasOwnProperty.call(req.body || {}, 'adminRole')) {
                const nextRole = String(req.body?.adminRole || '').trim();
                if (!ADMIN_ROLE_VALUES.includes(nextRole)) {
                    return res.status(400).json({ success: false, error: 'Invalid adminRole provided' });
                }
                admin.adminRole = nextRole;
                changed.adminRole = nextRole;
            }

            if (!Object.keys(changed).length) {
                return res.status(400).json({ success: false, error: 'No changes provided' });
            }

            await admin.save();
            await audit(req, admin._id, 'admin_update_admin_account', normalizeReason(req.body?.reason), changed);

            return res.json({ success: true, admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update admin account', details: error.message });
        }
    });

    app.post('/api/admin/management/admins/:id/deactivate', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            if (String(req.params.id) === String(req.adminUser._id)) {
                return res.status(403).json({ success: false, error: 'You cannot deactivate your own account' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            admin.isActive = false;
            await admin.save();
            await audit(req, admin._id, 'admin_deactivate_admin_account', normalizeReason(req.body?.reason), { email: admin.email });
            return res.json({ success: true, message: 'Admin account deactivated', admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to deactivate admin account', details: error.message });
        }
    });

    app.post('/api/admin/management/admins/:id/activate', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            admin.isActive = true;
            await admin.save();
            await audit(req, admin._id, 'admin_activate_admin_account', normalizeReason(req.body?.reason), { email: admin.email });
            return res.json({ success: true, message: 'Admin account activated', admin: serializeAdmin(admin) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to activate admin account', details: error.message });
        }
    });

    app.delete('/api/admin/management/admins/:id', requireAdmin, async (req, res) => {
        try {
            if (!canManageAdmins(req.adminUser)) {
                return res.status(403).json({ success: false, error: 'Super admin access required' });
            }

            if (String(req.params.id) === String(req.adminUser._id)) {
                return res.status(403).json({ success: false, error: 'You cannot delete your own account' });
            }

            const reason = normalizeReason(req.body?.reason);
            if (!reason) {
                return res.status(400).json({ success: false, error: 'A deletion reason is required' });
            }

            const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
            if (!admin) {
                return res.status(404).json({ success: false, error: 'Admin not found' });
            }

            await audit(req, admin._id, 'admin_delete_admin_account', reason, { email: admin.email, adminRole: admin.adminRole });
            await User.deleteOne({ _id: admin._id });
            return res.json({ success: true, message: 'Admin account deleted' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete admin account', details: error.message });
        }
    });
}

module.exports = registerAdminManagementRoutes;
