const mongoose = require('mongoose');

const hotspotSessionSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    hotspotUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HotspotUser'
    },
    username: {
        type: String,
        trim: true
    },
    ip: {
        type: String,
        trim: true
    },
    mac: {
        type: String,
        trim: true
    },
    uplinkBytes: {
        type: Number,
        default: 0
    },
    downlinkBytes: {
        type: Number,
        default: 0
    },
    currentUplinkBps: {
        type: Number,
        default: 0
    },
    currentDownlinkBps: {
        type: Number,
        default: 0
    },
    uptimeSeconds: {
        type: Number,
        default: 0
    },
    sessionTimeLeftSeconds: {
        type: Number,
        default: 0
    },
    idleTimeoutSeconds: {
        type: Number,
        default: 0
    },
    keepaliveTimeoutSeconds: {
        type: Number,
        default: 0
    },
    server: {
        type: String,
        trim: true,
        default: ''
    },
    hostName: {
        type: String,
        trim: true,
        default: ''
    },
    deviceLabel: {
        type: String,
        trim: true,
        default: ''
    },
    profile: {
        type: String,
        trim: true,
        default: ''
    },
    sessionId: {
        type: String,
        trim: true
    },
    startedAt: {
        type: Date
    },
    endedAt: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    collection: 'hotspot_sessions'
});

hotspotSessionSchema.index({ routerId: 1, isActive: 1 });

module.exports = mongoose.model('HotspotSession', hotspotSessionSchema);
