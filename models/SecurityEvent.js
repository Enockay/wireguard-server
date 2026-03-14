const mongoose = require('mongoose');

const securityEventSchema = new mongoose.Schema({
    eventType: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    category: {
        type: String,
        enum: ['auth', 'session', 'account', 'admin_security'],
        required: true,
        index: true
    },
    severity: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium',
        index: true
    },
    source: {
        type: String,
        enum: ['user', 'admin', 'system'],
        default: 'system',
        index: true
    },
    success: {
        type: Boolean,
        default: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    actorUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    sessionId: {
        type: String,
        trim: true,
        index: true
    },
    ipAddress: {
        type: String,
        trim: true,
        index: true
    },
    userAgent: {
        type: String,
        trim: true
    },
    reason: {
        type: String,
        trim: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    acknowledgedAt: {
        type: Date
    },
    acknowledgedBy: {
        type: String,
        trim: true
    },
    resolvedAt: {
        type: Date
    },
    resolvedBy: {
        type: String,
        trim: true
    },
    reviewedAt: {
        type: Date
    },
    reviewedBy: {
        type: String,
        trim: true
    },
    notes: [{
        body: {
            type: String,
            required: true,
            trim: true
        },
        category: {
            type: String,
            trim: true,
            default: 'review'
        },
        author: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true,
    collection: 'security_events'
});

securityEventSchema.index({ userId: 1, createdAt: -1 });
securityEventSchema.index({ sessionId: 1, createdAt: -1 });
securityEventSchema.index({ eventType: 1, createdAt: -1 });

module.exports = mongoose.model('SecurityEvent', securityEventSchema);
