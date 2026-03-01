const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        unique: true,
        index: true
    },
    status: {
        type: String,
        enum: ['trial', 'active', 'past_due', 'canceled', 'expired'],
        default: 'trial',
        index: true
    },
    planType: {
        type: String,
        enum: ['trial', 'monthly'],
        default: 'trial'
    },
    pricePerMonth: {
        type: Number,
        required: true,
        default: 0 // Will be set based on pricing config
    },
    currentPeriodStart: {
        type: Date,
        required: true,
        default: Date.now
    },
    currentPeriodEnd: {
        type: Date,
        required: true
    },
    trialEndsAt: {
        type: Date
    },
    canceledAt: {
        type: Date
    },
    nextBillingDate: {
        type: Date
    },
    lastPaymentDate: {
        type: Date
    },
    paymentMethod: {
        type: String,
        enum: ['manual', 'stripe', 'paypal', 'other'],
        default: 'manual'
    }
}, {
    timestamps: true,
    collection: 'subscriptions'
});

// Indexes
subscriptionSchema.index({ userId: 1, status: 1 });
subscriptionSchema.index({ currentPeriodEnd: 1 });
subscriptionSchema.index({ nextBillingDate: 1 });

// Check if subscription is active
subscriptionSchema.methods.isActive = function() {
    if (this.status === 'canceled' || this.status === 'expired') {
        return false;
    }
    return new Date() < this.currentPeriodEnd;
};

// Check if in trial
subscriptionSchema.methods.isTrial = function() {
    return this.planType === 'trial' && this.trialEndsAt && new Date() < this.trialEndsAt;
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
