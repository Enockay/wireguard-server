const mongoose = require('mongoose');

const monitoringIncidentSchema = new mongoose.Schema({
    incidentKey: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    source: {
        type: String,
        enum: ['derived', 'manual'],
        default: 'derived',
        index: true
    },
    sourceType: {
        type: String,
        enum: ['router', 'vpn_server', 'peer', 'platform', 'customer'],
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    severity: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'medium',
        index: true
    },
    status: {
        type: String,
        enum: ['open', 'acknowledged', 'resolved'],
        default: 'open',
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    summary: {
        type: String,
        trim: true
    },
    relatedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    relatedRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        index: true
    },
    relatedServerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VpnServer',
        index: true
    },
    relatedClientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        index: true
    },
    impact: {
        affectedRouters: {
            type: Number,
            default: 0
        },
        affectedUsers: {
            type: Number,
            default: 0
        }
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    firstDetectedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
        index: true
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
        author: {
            type: String,
            trim: true,
            default: 'system'
        },
        category: {
            type: String,
            trim: true,
            default: 'incident'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    timestamps: true,
    collection: 'monitoring_incidents'
});

monitoringIncidentSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
monitoringIncidentSchema.index({ sourceType: 1, status: 1, lastSeenAt: -1 });
monitoringIncidentSchema.index({ relatedRouterId: 1, status: 1, lastSeenAt: -1 });
monitoringIncidentSchema.index({ relatedServerId: 1, status: 1, lastSeenAt: -1 });
monitoringIncidentSchema.index({ relatedUserId: 1, status: 1, lastSeenAt: -1 });

module.exports = mongoose.model('MonitoringIncident', monitoringIncidentSchema);
