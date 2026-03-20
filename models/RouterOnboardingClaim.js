const crypto = require('crypto');
const mongoose = require('mongoose');

const routerOnboardingClaimSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    requestedName: {
        type: String,
        required: true,
        trim: true
    },
    serverNode: {
        type: String,
        default: 'wireguard',
        trim: true,
        index: true
    },
    reason: {
        type: String,
        trim: true
    },
    expectedAddressHint: {
        type: String,
        trim: true
    },
    tokenHash: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'claimed', 'adopted', 'cancelled', 'expired'],
        default: 'pending',
        index: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true
    },
    claimedAt: {
        type: Date,
        default: null
    },
    adoptedAt: {
        type: Date,
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    provisionedRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        default: null,
        index: true
    },
    detected: {
        sourceIp: {
            type: String,
            trim: true
        },
        userAgent: {
            type: String,
            trim: true
        },
        identity: {
            type: String,
            trim: true
        },
        boardName: {
            type: String,
            trim: true
        },
        serialNumber: {
            type: String,
            trim: true
        },
        routerosVersion: {
            type: String,
            trim: true
        },
        wanIp: {
            type: String,
            trim: true
        },
        lanIp: {
            type: String,
            trim: true
        },
        lastSeenAt: {
            type: Date,
            default: null
        },
        matchedExpectedAddress: {
            type: Boolean,
            default: null
        }
    }
}, {
    timestamps: true,
    collection: 'router_onboarding_claims'
});

routerOnboardingClaimSchema.index({ status: 1, createdAt: -1 });

routerOnboardingClaimSchema.statics.hashToken = function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
};

module.exports = mongoose.model('RouterOnboardingClaim', routerOnboardingClaimSchema);
