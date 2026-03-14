const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
    referrerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    referredId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    referralCode: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'rewarded'],
        default: 'pending',
        index: true
    },
    rewardGiven: {
        type: Boolean,
        default: false
    },
    rewardAmount: {
        type: Number,
        default: 0
    },
    completedAt: {
        type: Date
    }
}, {
    timestamps: true,
    collection: 'referrals'
});

// Indexes
referralSchema.index({ referrerId: 1, status: 1 });

module.exports = mongoose.model('Referral', referralSchema);
