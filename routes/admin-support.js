const SupportTicket = require("../models/SupportTicket");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");

function registerAdminSupportRoutes(app, getDbInitialized) {
    // List all tickets, across all users
    app.get("/api/admin/support-tickets", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { page = 1, limit = 50, status, category, priority, search } = req.query;

            const query = {};
            if (status) query.status = status;
            if (category) query.category = category;
            if (priority) query.priority = priority;
            if (search) query.subject = { $regex: search, $options: 'i' };

            const skip = (parseInt(page) - 1) * parseInt(limit);

            const [tickets, total] = await Promise.all([
                SupportTicket.find(query)
                    .populate('userId', 'name email')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(parseInt(limit)),
                SupportTicket.countDocuments(query)
            ]);

            res.json({
                success: true,
                tickets: tickets.map(t => ({
                    id: t._id,
                    subject: t.subject,
                    category: t.category,
                    priority: t.priority,
                    status: t.status,
                    user: t.userId ? { id: t.userId._id, name: t.userId.name, email: t.userId.email } : null,
                    messageCount: t.messages.length,
                    createdAt: t.createdAt,
                    updatedAt: t.updatedAt
                })),
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'admin_list_tickets_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to list tickets", details: error.message });
        }
    });

    // Get a single ticket, regardless of owner
    app.get("/api/admin/support-tickets/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            const ticket = await SupportTicket.findById(id)
                .populate('userId', 'name email')
                .populate('assignedTo', 'name email')
                .populate('messages.userId', 'name email role');

            if (!ticket) {
                return res.status(404).json({ success: false, error: "Ticket not found" });
            }

            res.json({
                success: true,
                ticket: {
                    id: ticket._id,
                    subject: ticket.subject,
                    description: ticket.description,
                    category: ticket.category,
                    priority: ticket.priority,
                    status: ticket.status,
                    user: ticket.userId ? { id: ticket.userId._id, name: ticket.userId.name, email: ticket.userId.email } : null,
                    assignedTo: ticket.assignedTo ? { id: ticket.assignedTo._id, name: ticket.assignedTo.name, email: ticket.assignedTo.email } : null,
                    messages: ticket.messages.map(msg => ({
                        id: msg._id,
                        userId: msg.userId?._id,
                        userName: msg.userId?.name,
                        isAdmin: msg.userId?.role === 'admin',
                        message: msg.message,
                        attachments: msg.attachments,
                        createdAt: msg.createdAt
                    })),
                    resolvedAt: ticket.resolvedAt,
                    closedAt: ticket.closedAt,
                    createdAt: ticket.createdAt,
                    updatedAt: ticket.updatedAt
                }
            });
        } catch (error) {
            log('error', 'admin_get_ticket_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to get ticket", details: error.message });
        }
    });

    // Reply to a ticket as admin
    app.post("/api/admin/support-tickets/:id/messages", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { message } = req.body;

            if (!message) {
                return res.status(400).json({ success: false, error: "Message is required" });
            }

            const ticket = await SupportTicket.findById(id);
            if (!ticket) {
                return res.status(404).json({ success: false, error: "Ticket not found" });
            }

            ticket.messages.push({ userId: req.user.userId, message });
            if (ticket.status === 'open') {
                ticket.status = 'in_progress';
            }
            await ticket.save();

            res.json({
                success: true,
                message: "Reply added successfully",
                ticket: { id: ticket._id, status: ticket.status, messageCount: ticket.messages.length }
            });
        } catch (error) {
            log('error', 'admin_reply_ticket_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to add reply", details: error.message });
        }
    });

    // Update ticket status / priority / assignment
    app.patch("/api/admin/support-tickets/:id", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { status, priority, assignedTo } = req.body;

            const ticket = await SupportTicket.findById(id);
            if (!ticket) {
                return res.status(404).json({ success: false, error: "Ticket not found" });
            }

            if (status !== undefined) {
                if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
                    return res.status(400).json({ success: false, error: "Invalid status" });
                }
                ticket.status = status;
                if (status === 'resolved') ticket.resolvedAt = new Date();
                if (status === 'closed') ticket.closedAt = new Date();
            }
            if (priority !== undefined) {
                if (!['low', 'medium', 'high', 'urgent'].includes(priority)) {
                    return res.status(400).json({ success: false, error: "Invalid priority" });
                }
                ticket.priority = priority;
            }
            if (assignedTo !== undefined) {
                ticket.assignedTo = assignedTo || null;
            }

            await ticket.save();

            res.json({ success: true, message: "Ticket updated successfully", ticket: { id: ticket._id, status: ticket.status, priority: ticket.priority } });
        } catch (error) {
            log('error', 'admin_update_ticket_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to update ticket", details: error.message });
        }
    });
}

module.exports = registerAdminSupportRoutes;
