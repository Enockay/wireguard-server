const mongoose = require('mongoose');

const hotspotUserSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    username: {
        type: String,
        required: true,
        trim: true
    },
    password: {
        type: String,
        trim: true
    },
    profile: {
        type: String,
        default: 'default',
        trim: true
    },
    comment: {
        type: String,
        trim: true
    },
    dataLimitBytes: {
        type: Number,
        default: 0
    },
    timeLimitSeconds: {
        type: Number,
        default: 0
    },
    expiresAt: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    bytesIn: {
        type: Number,
        default: 0
    },
    bytesOut: {
        type: Number,
        default: 0
    },
    routerosId: {
        type: String,
        trim: true
    },
    createdBy: {
        type: String,
        default: 'admin'
    }
}, {
    timestamps: true,
    collection: 'hotspot_users'
});

hotspotUserSchema.index({ routerId: 1, username: 1 }, { unique: true });

module.exports = mongoose.model('HotspotUser', hotspotUserSchema);
