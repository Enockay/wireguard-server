const SupportTicket = require('../models/SupportTicket');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');

function registerSupportRoutes(app) {
    // Create support ticket
    app.post('/api/support/tickets', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { subject, description, category = 'general', priority = 'medium' } = req.body;

            if (!subject || !description) {
                return res.status(400).json({
                    success: false,
                    error: 'Subject and description are required'
                });
            }

            const ticket = new SupportTicket({
                userId,
                subject,
                description,
                category,
                priority,
                messages: [{
                    userId,
                    message: description
                }]
            });

            await ticket.save();

            res.status(201).json({
                success: true,
                message: 'Support ticket created successfully',
                ticket: {
                    id: ticket._id,
                    subject: ticket.subject,
                    category: ticket.category,
                    priority: ticket.priority,
                    status: ticket.status,
                    createdAt: ticket.createdAt
                }
            });
        } catch (error) {
            log('error', 'create_ticket_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to create support ticket',
                details: error.message
            });
        }
    });

    // Get user's tickets
    app.get('/api/support/tickets', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { page = 1, limit = 20, status, category } = req.query;

            const query = { userId };
            if (status) query.status = status;
            if (category) query.category = category;

            const tickets = await SupportTicket.find(query)
                .sort({ createdAt: -1 })
                .limit(parseInt(limit))
                .skip((parseInt(page) - 1) * parseInt(limit))
                .select('subject category priority status createdAt updatedAt');

            const total = await SupportTicket.countDocuments(query);

            res.json({
                success: true,
                tickets: tickets.map(t => ({
                    id: t._id,
                    subject: t.subject,
                    category: t.category,
                    priority: t.priority,
                    status: t.status,
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
            log('error', 'get_tickets_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get support tickets',
                details: error.message
            });
        }
    });

    // Get single ticket
    app.get('/api/support/tickets/:id', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { id } = req.params;

            const ticket = await SupportTicket.findOne({ _id: id, userId })
                .populate('userId', 'name email')
                .populate('messages.userId', 'name email');

            if (!ticket) {
                return res.status(404).json({
                    success: false,
                    error: 'Ticket not found'
                });
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
                    messages: ticket.messages.map(msg => ({
                        id: msg._id,
                        userId: msg.userId._id,
                        userName: msg.userId.name,
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
            log('error', 'get_ticket_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get ticket',
                details: error.message
            });
        }
    });

    // Add message to ticket
    app.post('/api/support/tickets/:id/messages', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { id } = req.params;
            const { message } = req.body;

            if (!message) {
                return res.status(400).json({
                    success: false,
                    error: 'Message is required'
                });
            }

            const ticket = await SupportTicket.findOne({ _id: id, userId });

            if (!ticket) {
                return res.status(404).json({
                    success: false,
                    error: 'Ticket not found'
                });
            }

            if (ticket.status === 'closed') {
                return res.status(400).json({
                    success: false,
                    error: 'Cannot add message to closed ticket'
                });
            }

            ticket.messages.push({
                userId,
                message
            });

            // Reopen if resolved
            if (ticket.status === 'resolved') {
                ticket.status = 'in_progress';
            }

            await ticket.save();

            res.json({
                success: true,
                message: 'Message added successfully',
                ticket: {
                    id: ticket._id,
                    status: ticket.status,
                    messageCount: ticket.messages.length
                }
            });
        } catch (error) {
            log('error', 'add_message_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to add message',
                details: error.message
            });
        }
    });

    // Close ticket
    app.post('/api/support/tickets/:id/close', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { id } = req.params;

            const ticket = await SupportTicket.findOne({ _id: id, userId });

            if (!ticket) {
                return res.status(404).json({
                    success: false,
                    error: 'Ticket not found'
                });
            }

            ticket.status = 'closed';
            ticket.closedAt = new Date();
            await ticket.save();

            res.json({
                success: true,
                message: 'Ticket closed successfully',
                ticket: {
                    id: ticket._id,
                    status: ticket.status
                }
            });
        } catch (error) {
            log('error', 'close_ticket_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to close ticket',
                details: error.message
            });
        }
    });
}

module.exports = registerSupportRoutes;
