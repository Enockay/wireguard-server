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
