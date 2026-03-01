const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['payment', 'invoice', 'refund'],
        required: true,
        index: true
    },
    transactionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        default: 'USD'
    },
    description: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending',
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ['paypal', 'paystack', 'balance', 'manual'],
        default: 'balance'
    },
    paymentGatewayId: {
        type: String // PayPal or Paystack transaction ID
    },
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter'
    },
    subscriptionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription'
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed // Store additional payment data
    }
}, {
    timestamps: true,
    collection: 'transactions'
});

// Indexes
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ transactionId: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
