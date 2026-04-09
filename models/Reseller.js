const mongoose = require('mongoose');

const resellerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        index: true
    },
    companyName: {
        type: String,
        trim: true
    },
    contactName: {
        type: String,
        trim: true
    },
    contactEmail: {
        type: String,
        trim: true,
        lowercase: true
    },
    contactPhone: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
        index: true
    },
    territory: {
        type: String,
        trim: true
    },
    commissionRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    priceOverridePercent: {
        type: Number,
        default: 0,
        min: -100,
        max: 100
    },
    notes: {
        type: String,
        trim: true
    },
    assignedUserIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    assignedRouterIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter'
    }],
    assignedPlanIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServicePlan'
    }],
    payoutBalance: {
        type: Number,
        default: 0
    },
    totalPaidOut: {
        type: Number,
        default: 0
    },
    lastPayoutAt: {
        type: Date
    },
    lastPayoutReference: {
        type: String,
        trim: true
    },
    createdBy: {
        type: String,
        trim: true,
        default: 'system'
    }
}, {
    timestamps: true,
    collection: 'resellers'
});

resellerSchema.index({ name: 1 });

module.exports = mongoose.model('Reseller', resellerSchema);
