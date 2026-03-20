const mongoose = require('mongoose');

const voucherSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServicePlan', required: true },
    denomination: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    validityDays: { type: Number, required: true },
    status: { type: String, enum: ['unused', 'used', 'expired', 'revoked'], default: 'unused', index: true },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    batchId: { type: String, index: true, default: null },
    createdBy: { type: String, default: '' },
}, {
    timestamps: true,
    collection: 'vouchers'
});

voucherSchema.index({ planId: 1, status: 1 });
voucherSchema.index({ planId: 1, batchId: 1 });

module.exports = mongoose.model('Voucher', voucherSchema);
