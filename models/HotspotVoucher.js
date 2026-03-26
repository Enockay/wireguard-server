const mongoose = require('mongoose');

const hotspotVoucherSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    hotspotUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HotspotUser',
        default: null
    },
    username: {
        type: String,
        required: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        trim: true
    },
    profile: {
        type: String,
        default: 'default',
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
    comment: {
        type: String,
        default: '',
        trim: true
    },
    batchId: {
        type: String,
        default: '',
        index: true
    },
    status: {
        type: String,
        enum: ['unused', 'used', 'expired', 'revoked'],
        default: 'unused',
        index: true
    },
    expiresAt: {
        type: Date,
        default: null
    },
    usedAt: {
        type: Date,
        default: null
    },
    revokedAt: {
        type: Date,
        default: null
    },
    createdBy: {
        type: String,
        default: 'system',
        trim: true
    }
}, {
    timestamps: true,
    collection: 'hotspot_vouchers'
});

hotspotVoucherSchema.index({ routerId: 1, createdAt: -1 });
hotspotVoucherSchema.index({ routerId: 1, username: 1 }, { unique: true });

module.exports = mongoose.model('HotspotVoucher', hotspotVoucherSchema);
