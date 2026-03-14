const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
    action: {
        type: String,
        required: true,
        index: true,
        trim: true
    },
    actorUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    targetUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    targetRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        index: true
    },
    targetServerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VpnServer',
        index: true
    },
    targetIncidentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MonitoringIncident',
        index: true
    },
    targetTicketId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SupportTicket',
        index: true
    },
    targetSecurityEventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SecurityEvent',
        index: true
    },
    targetSessionId: {
        type: String,
        trim: true,
        index: true
    },
    reason: {
        type: String,
        trim: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    ipAddress: {
        type: String,
        trim: true
    },
    userAgent: {
        type: String,
        trim: true
    }
}, {
    timestamps: true,
    collection: 'admin_audit_logs'
});

adminAuditLogSchema.index({ targetUserId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetRouterId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetServerId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetIncidentId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetTicketId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetSecurityEventId: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetSessionId: 1, createdAt: -1 });
adminAuditLogSchema.index({ actorUserId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
