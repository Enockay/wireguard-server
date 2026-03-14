const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    category: {
        type: String,
        enum: ['technical', 'billing', 'general', 'feature_request', 'bug_report'],
        default: 'general',
        index: true
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium',
        index: true
    },
    status: {
        type: String,
        enum: ['open', 'in_progress', 'resolved', 'closed'],
        default: 'open',
        index: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    assignedTeam: {
        type: String,
        enum: ['general', 'networking', 'billing', 'security', 'vip', 'operations'],
        default: 'general',
        index: true
    },
    assignedAt: {
        type: Date
    },
    escalated: {
        type: Boolean,
        default: false,
        index: true
    },
    escalatedAt: {
        type: Date
    },
    escalationReason: {
        type: String,
        trim: true
    },
    lastReplyAt: {
        type: Date
    },
    lastReplyDirection: {
        type: String,
        enum: ['customer', 'admin', 'system']
    },
    lastReviewedAt: {
        type: Date
    },
    slaPolicy: {
        firstResponseTargetHours: {
            type: Number,
            default: 24
        },
        resolutionTargetHours: {
            type: Number,
            default: 72
        }
    },
    firstResponseDueAt: {
        type: Date,
        index: true
    },
    resolutionDueAt: {
        type: Date,
        index: true
    },
    firstResponseAt: {
        type: Date
    },
    firstResolutionAt: {
        type: Date
    },
    slaBreachedAt: {
        type: Date
    },
    customerNotifiedAt: {
        type: Date
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    relatedResources: {
        routerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'MikrotikRouter'
        },
        serverId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VpnServer'
        },
        incidentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'MonitoringIncident'
        },
        subscriptionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Subscription'
        },
        transactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Transaction'
        }
    },
    messages: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        message: {
            type: String,
            required: true
        },
        attachments: [{
            filename: String,
            url: String,
            size: Number
        }],
        source: {
            type: String,
            enum: ['customer', 'admin', 'system'],
            default: 'customer'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    internalNotes: [{
        body: {
            type: String,
            required: true,
            trim: true
        },
        category: {
            type: String,
            enum: ['support', 'escalation', 'billing', 'networking', 'provisioning', 'security', 'follow_up', 'vip'],
            default: 'support'
        },
        pinned: {
            type: Boolean,
            default: false
        },
        author: {
            type: String,
            trim: true,
            default: 'system'
        },
        authorUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    internalFlags: [{
        flag: {
            type: String,
            trim: true
        },
        severity: {
            type: String,
            enum: ['low', 'medium', 'high'],
            default: 'medium'
        },
        description: {
            type: String,
            trim: true
        },
        createdBy: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdByUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    workflowEvents: [{
        eventType: {
            type: String,
            required: true,
            trim: true
        },
        actorType: {
            type: String,
            enum: ['customer', 'admin', 'system'],
            default: 'system'
        },
        actorUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        summary: {
            type: String,
            trim: true
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    resolvedAt: {
        type: Date
    },
    closedAt: {
        type: Date
    }
}, {
    timestamps: true,
    collection: 'support_tickets'
});

// Indexes
supportTicketSchema.index({ userId: 1, status: 1 });
supportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ escalated: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ assignedTeam: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
