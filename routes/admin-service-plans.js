const crypto = require('crypto');
const ServicePlan = require('../models/ServicePlan');
const Voucher = require('../models/Voucher');
const { requireAdmin } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');

const PLAN_TYPES = ['monthly', 'weekly', 'daily', 'prepaid'];
const VOUCHER_STATUS = ['unused', 'used', 'expired', 'revoked'];
const VOUCHER_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function normalizeQueryBoolean(value) {
    if (value === undefined) return undefined;
    if (String(value).toLowerCase() === 'true') return true;
    if (String(value).toLowerCase() === 'false') return false;
    return undefined;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPositiveNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function serializePlan(plan) {
    return {
        id: String(plan._id),
        name: plan.name,
        description: plan.description || null,
        planType: plan.planType,
        price: plan.price,
        currency: plan.currency,
        dataCapGB: plan.dataCapGB || 0,
        speedDownloadKbps: plan.speedDownloadKbps || 0,
        speedUploadKbps: plan.speedUploadKbps || 0,
        fupEnabled: Boolean(plan.fupEnabled),
        fupThresholdGB: plan.fupThresholdGB || 0,
        fupSpeedDownloadKbps: plan.fupSpeedDownloadKbps || 0,
        fupSpeedUploadKbps: plan.fupSpeedUploadKbps || 0,
        validityDays: plan.validityDays || 30,
        peakSpeedEnabled: Boolean(plan.peakSpeedEnabled),
        peakHoursStart: plan.peakHoursStart ?? 8,
        peakHoursEnd: plan.peakHoursEnd ?? 22,
        peakSpeedDownloadKbps: plan.peakSpeedDownloadKbps || 0,
        offPeakSpeedDownloadKbps: plan.offPeakSpeedDownloadKbps || 0,
        isActive: Boolean(plan.isActive),
        assignedToAllRouters: Boolean(plan.assignedToAllRouters),
        routerIds: Array.isArray(plan.routerIds) ? plan.routerIds.map((id) => String(id)) : [],
        subscriberCount: plan.subscriberCount || 0,
        createdBy: plan.createdBy || '',
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt
    };
}

function serializeVoucher(voucher) {
    return {
        id: String(voucher._id),
        code: voucher.code,
        planId: typeof voucher.planId === 'object' && voucher.planId?._id ? String(voucher.planId._id) : String(voucher.planId),
        denomination: voucher.denomination,
        currency: voucher.currency,
        validityDays: voucher.validityDays,
        status: voucher.status,
        usedBy: voucher.usedBy ? String(voucher.usedBy) : null,
        usedAt: voucher.usedAt || null,
        expiresAt: voucher.expiresAt,
        batchId: voucher.batchId || null
    };
}

function createVoucherCode() {
    const buildChunk = () => Array.from({ length: 4 }, () => VOUCHER_CHARS[Math.floor(Math.random() * VOUCHER_CHARS.length)]).join('');
    return `${buildChunk()}-${buildChunk()}`;
}

async function createUniqueVoucherCode() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const code = createVoucherCode();
        const existing = await Voucher.exists({ code });
        if (!existing) return code;
    }
    return `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

async function audit(req, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        action,
        reason,
        metadata
    });
}

function buildPlanPayload(body = {}, createdBy = '') {
    const payload = {
        name: String(body.name || '').trim(),
        description: body.description ? String(body.description).trim() : '',
        planType: PLAN_TYPES.includes(String(body.planType || '').trim()) ? String(body.planType).trim() : 'monthly',
        price: toPositiveNumber(body.price),
        currency: body.currency ? String(body.currency).trim().toUpperCase() : 'USD',
        dataCapGB: toPositiveNumber(body.dataCapGB),
        speedDownloadKbps: toPositiveNumber(body.speedDownloadKbps),
        speedUploadKbps: toPositiveNumber(body.speedUploadKbps),
        fupEnabled: Boolean(body.fupEnabled),
        fupThresholdGB: toPositiveNumber(body.fupThresholdGB),
        fupSpeedDownloadKbps: toPositiveNumber(body.fupSpeedDownloadKbps, 512),
        fupSpeedUploadKbps: toPositiveNumber(body.fupSpeedUploadKbps, 256),
        validityDays: Math.max(1, Math.floor(toPositiveNumber(body.validityDays, 30) || 30)),
        peakSpeedEnabled: Boolean(body.peakSpeedEnabled),
        peakHoursStart: Math.min(23, Math.max(0, Math.floor(toPositiveNumber(body.peakHoursStart, 8)))),
        peakHoursEnd: Math.min(23, Math.max(0, Math.floor(toPositiveNumber(body.peakHoursEnd, 22)))),
        peakSpeedDownloadKbps: toPositiveNumber(body.peakSpeedDownloadKbps),
        offPeakSpeedDownloadKbps: toPositiveNumber(body.offPeakSpeedDownloadKbps),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        createdBy
    };

    if (!payload.name || payload.price < 0) {
        return null;
    }

    return payload;
}

function registerAdminServicePlanRoutes(app) {
    app.get('/api/admin/settings/platform', requireAdmin, async (_req, res) => {
        const pkg = require('../package.json');
        return res.json({
            success: true,
            config: {
                routerMonthlyPrice: Number(process.env.ROUTER_MONTHLY_PRICE || '10.00'),
                trialDays: Number(process.env.TRIAL_DAYS || '7'),
                serverRegion: process.env.SERVER_REGION || 'primary',
                appVersion: pkg.version || '1.0.0'
            }
        });
    });

    app.get('/api/admin/service-plans', requireAdmin, async (req, res) => {
        try {
            const query = {};
            const active = normalizeQueryBoolean(req.query?.isActive);
            if (active !== undefined) query.isActive = active;
            if (req.query?.planType && PLAN_TYPES.includes(String(req.query.planType))) {
                query.planType = String(req.query.planType);
            }
            if (req.query?.q) {
                const pattern = new RegExp(escapeRegex(req.query.q), 'i');
                query.$or = [{ name: pattern }, { description: pattern }];
            }

            const plans = await ServicePlan.find(query).sort({ createdAt: -1 }).lean();
            return res.json({ success: true, items: plans.map(serializePlan) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load service plans', details: error.message });
        }
    });

    app.post('/api/admin/service-plans', requireAdmin, async (req, res) => {
        try {
            const payload = buildPlanPayload(req.body || {}, req.adminUser.email || 'system');
            if (!payload) {
                return res.status(400).json({ success: false, error: 'Valid name and price are required' });
            }

            const existing = await ServicePlan.findOne({ name: payload.name });
            if (existing) {
                return res.status(409).json({ success: false, error: 'A service plan with this name already exists' });
            }

            const plan = await ServicePlan.create(payload);
            await audit(req, 'admin_create_service_plan', normalizeReason(req.body?.reason), { planId: plan._id, name: plan.name });
            return res.status(201).json({ success: true, plan: serializePlan(plan) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create service plan', details: error.message });
        }
    });

    app.get('/api/admin/service-plans/:id', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.id).lean();
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }
            return res.json({ success: true, plan: serializePlan(plan) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load service plan', details: error.message });
        }
    });

    app.put('/api/admin/service-plans/:id', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.id);
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }

            const payload = buildPlanPayload({ ...plan.toObject(), ...req.body }, plan.createdBy || req.adminUser.email || 'system');
            if (!payload) {
                return res.status(400).json({ success: false, error: 'Valid name and price are required' });
            }

            const duplicate = await ServicePlan.findOne({ name: payload.name, _id: { $ne: plan._id } });
            if (duplicate) {
                return res.status(409).json({ success: false, error: 'A service plan with this name already exists' });
            }

            Object.assign(plan, payload);
            await plan.save();
            await audit(req, 'admin_update_service_plan', normalizeReason(req.body?.reason), { planId: plan._id, fields: Object.keys(req.body || {}) });
            return res.json({ success: true, plan: serializePlan(plan) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update service plan', details: error.message });
        }
    });

    app.post('/api/admin/service-plans/:id/deactivate', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.id);
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }
            plan.isActive = false;
            await plan.save();
            await audit(req, 'admin_deactivate_service_plan', normalizeReason(req.body?.reason), { planId: plan._id, name: plan.name });
            return res.json({
                success: true,
                message: 'Service plan deactivated',
                warning: 'Active subscriber linkage is not enforced yet for service plans.',
                plan: serializePlan(plan)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to deactivate service plan', details: error.message });
        }
    });

    app.delete('/api/admin/service-plans/:id', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.id);
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }
            plan.isActive = false;
            plan.name = `${plan.name}_deleted_${Date.now()}`;
            await plan.save();
            await audit(req, 'admin_delete_service_plan', normalizeReason(req.body?.reason), { planId: plan._id });
            return res.json({ success: true, message: 'Service plan archived' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete service plan', details: error.message });
        }
    });

    app.post('/api/admin/service-plans/:planId/vouchers/generate', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.planId);
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }

            const quantity = Math.floor(Number(req.body?.quantity));
            if (!Number.isFinite(quantity) || quantity < 1 || quantity > 500) {
                return res.status(400).json({ success: false, error: 'quantity must be between 1 and 500' });
            }

            const validityDays = Math.max(1, Math.floor(Number(req.body?.validityDays || plan.validityDays || 30)));
            const batchLabel = String(req.body?.batchName || '').trim();
            const batchId = `${batchLabel ? `${batchLabel.replace(/\s+/g, '-').toLowerCase()}-` : ''}${Date.now()}`;
            const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

            const vouchers = [];
            for (let index = 0; index < quantity; index += 1) {
                vouchers.push({
                    code: await createUniqueVoucherCode(),
                    planId: plan._id,
                    denomination: plan.price,
                    currency: plan.currency,
                    validityDays,
                    expiresAt,
                    batchId,
                    createdBy: req.adminUser.email || 'system'
                });
            }

            await Voucher.insertMany(vouchers);
            await audit(req, 'admin_generate_vouchers', normalizeReason(req.body?.reason), { planId: plan._id, batchId, quantity });
            return res.json({ success: true, batchId, count: quantity });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to generate vouchers', details: error.message });
        }
    });

    app.get('/api/admin/service-plans/:planId/vouchers', requireAdmin, async (req, res) => {
        try {
            const plan = await ServicePlan.findById(req.params.planId).select('_id name').lean();
            if (!plan) {
                return res.status(404).json({ success: false, error: 'Service plan not found' });
            }

            const page = Math.max(1, Number(req.query?.page) || 1);
            const limit = 50;
            const query = { planId: req.params.planId };
            if (req.query?.status && VOUCHER_STATUS.includes(String(req.query.status))) {
                query.status = String(req.query.status);
            }
            if (req.query?.batchId) {
                query.batchId = String(req.query.batchId);
            }

            const [items, total] = await Promise.all([
                Voucher.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
                Voucher.countDocuments(query)
            ]);

            return res.json({
                success: true,
                items: items.map(serializeVoucher),
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit) || 1
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load vouchers', details: error.message });
        }
    });

    app.get('/api/admin/service-plans/vouchers/export', requireAdmin, async (req, res) => {
        try {
            const query = {};
            if (req.query?.planId) {
                query.planId = String(req.query.planId);
            }
            if (req.query?.batchId) {
                query.batchId = String(req.query.batchId);
            }
            query.status = 'unused';

            const vouchers = await Voucher.find(query).populate('planId', 'name').sort({ createdAt: -1 }).lean();
            const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
            const rows = [
                ['Code', 'Plan', 'Denomination', 'Currency', 'ValidityDays', 'ExpiresAt', 'Status'].map(escapeCsv).join(','),
                ...vouchers.map((voucher) => [
                    voucher.code,
                    voucher.planId?.name || '',
                    voucher.denomination,
                    voucher.currency,
                    voucher.validityDays,
                    voucher.expiresAt ? new Date(voucher.expiresAt).toISOString() : '',
                    voucher.status
                ].map(escapeCsv).join(','))
            ];

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="vouchers-${Date.now()}.csv"`);
            return res.send(rows.join('\n'));
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to export vouchers', details: error.message });
        }
    });

    app.post('/api/admin/service-plans/vouchers/:code/revoke', requireAdmin, async (req, res) => {
        try {
            const voucher = await Voucher.findOne({ code: String(req.params.code || '').trim().toUpperCase() });
            if (!voucher) {
                return res.status(404).json({ success: false, error: 'Voucher not found' });
            }
            voucher.status = 'revoked';
            await voucher.save();
            await audit(req, 'admin_revoke_voucher', normalizeReason(req.body?.reason), { code: voucher.code, planId: voucher.planId });
            return res.json({ success: true, message: 'Voucher revoked', voucher: serializeVoucher(voucher) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to revoke voucher', details: error.message });
        }
    });
}

module.exports = registerAdminServicePlanRoutes;
