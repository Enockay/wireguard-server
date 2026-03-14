const mongoose = require('mongoose');

const userSessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    source: {
        type: String,
        enum: ['signup', 'login', 'api'],
        default: 'login',
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
    issuedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    revokedAt: {
        type: Date,
        index: true
    },
    revokedBy: {
        type: String,
        trim: true
    },
    revokeReason: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['active', 'revoked', 'expired'],
        default: 'active',
        index: true
    }
}, {
    timestamps: true,
    collection: 'user_sessions'
});

userSessionSchema.index({ userId: 1, status: 1, issuedAt: -1 });

module.exports = mongoose.model('UserSession', userSessionSchema);
