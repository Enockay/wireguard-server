const mongoose = require('mongoose');

const servicePlanSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, default: '' },
    planType: { type: String, enum: ['monthly', 'weekly', 'daily', 'prepaid'], default: 'monthly', index: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    dataCapGB: { type: Number, default: 0 },
    speedDownloadKbps: { type: Number, default: 0 },
    speedUploadKbps: { type: Number, default: 0 },
    fupEnabled: { type: Boolean, default: false },
    fupThresholdGB: { type: Number, default: 0 },
    fupSpeedDownloadKbps: { type: Number, default: 512 },
    fupSpeedUploadKbps: { type: Number, default: 256 },
    validityDays: { type: Number, default: 30 },
    peakSpeedEnabled: { type: Boolean, default: false },
    peakHoursStart: { type: Number, default: 8 },
    peakHoursEnd: { type: Number, default: 22 },
    peakSpeedDownloadKbps: { type: Number, default: 0 },
    offPeakSpeedDownloadKbps: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    assignedToAllRouters: { type: Boolean, default: true },
    routerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MikrotikRouter' }],
    subscriberCount: { type: Number, default: 0 },
    createdBy: { type: String, trim: true, default: '' },
}, {
    timestamps: true,
    collection: 'service_plans'
});

servicePlanSchema.index({ name: 1 });
servicePlanSchema.index({ isActive: 1, planType: 1 });

module.exports = mongoose.model('ServicePlan', servicePlanSchema);
