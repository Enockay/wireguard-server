const mongoose = require('mongoose');

const platformConfigSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: 'primary'
    },
    routerMonthlyPrice: {
        type: Number,
        default: 10
    },
    trialDays: {
        type: Number,
        default: 7
    },
    serverRegion: {
        type: String,
        default: 'primary',
        trim: true
    },
    supportEmail: {
        type: String,
        trim: true,
        lowercase: true
    },
    billingGraceDays: {
        type: Number,
        default: 3
    },
    updatedBy: {
        type: String,
        trim: true,
        default: 'system'
    }
}, {
    timestamps: true,
    collection: 'platform_config'
});

module.exports = mongoose.model('PlatformConfig', platformConfigSchema);
