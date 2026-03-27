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
    rewardCurrency: {
        type: String,
        default: 'USD'
    },
    completedAt: {
        type: Date
    },
    reviewStatus: {
        type: String,
        enum: ['pending_review', 'approved', 'rejected', 'paid'],
        default: 'pending_review',
        index: true
    },
    reviewNote: {
        type: String,
        default: ''
    },
    reviewedAt: {
        type: Date
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    offerTitle: {
        type: String,
        default: 'Standard referral reward'
    },
    offerDescription: {
        type: String,
        default: 'Referral reward issued after admin review and payout approval.'
    },
    payoutStatus: {
        type: String,
        enum: ['not_ready', 'offered', 'queued', 'paid', 'withheld'],
        default: 'not_ready',
        index: true
    },
    payoutMethod: {
        type: String,
        enum: ['account_credit', 'mpesa', 'bank_transfer', 'cash', 'voucher', 'manual_review'],
        default: 'account_credit'
    },
    payoutReference: {
        type: String,
        default: ''
    },
    payoutNote: {
        type: String,
        default: ''
    },
    payoutOfferedAt: {
        type: Date
    },
    payoutQueuedAt: {
        type: Date
    },
    paidAt: {
        type: Date
    },
    paidBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true,
    collection: 'referrals'
});

// Indexes
referralSchema.index({ referrerId: 1, status: 1 });

module.exports = mongoose.model('Referral', referralSchema);
