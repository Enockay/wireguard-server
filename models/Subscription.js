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
        enum: ['trial', 'active', 'past_due', 'suspended', 'canceled', 'expired'],
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
    enforcedAt: {
        type: Date,
        default: null
    },
    paymentMethod: {
        type: String,
        enum: ['manual', 'balance', 'mpesa', 'stripe', 'paypal', 'paystack', 'airtel_money', 'bank_transfer', 'cash', 'other'],
        default: 'manual'
    },
    servicePlanId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServicePlan',
        default: null,
        index: true
    },
    subscriberIp: {
        type: String,
        trim: true,
        default: ''
    },
    queueName: {
        type: String,
        trim: true,
        default: ''
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
    if (['canceled', 'expired', 'suspended'].includes(this.status)) {
        return false;
    }
    return new Date() < this.currentPeriodEnd;
};

// Check if in trial
subscriptionSchema.methods.isTrial = function() {
    return this.planType === 'trial' && this.trialEndsAt && new Date() < this.trialEndsAt;
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
