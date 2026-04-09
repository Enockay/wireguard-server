const crypto = require('crypto');
const Referral = require('../models/Referral');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const { log } = require('../wg-core');

const ADMIN_REFERRAL_PERMISSIONS = {
    VIEW: 'admin.referrals.view',
    MANAGE: 'admin.referrals.manage',
    CONFIGURE: 'admin.referrals.configure'
};

function generateTransactionId(prefix = 'REF-') {
    return `${prefix}${Date.now()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function normalizeText(value) {
    const normalized = value == null ? '' : String(value).trim();
    return normalized || '';
}

function normalizeAmount(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
        throw new Error('Reward amount must be a valid positive number');
    }
    return amount;
}

function paginate(items, page = 1, limit = 20) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const total = items.length;
    const start = (safePage - 1) * safeLimit;
    return {
        items: items.slice(start, start + safeLimit),
        pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit) || 1
        }
    };
}

function matchesSearch(referral, query) {
    if (!query) return true;
    const value = query.toLowerCase();
    const haystacks = [
        referral.referrerId?.name,
        referral.referrerId?.email,
        referral.referredId?.name,
        referral.referredId?.email,
        referral.referralCode,
        referral.offerTitle,
        referral.offerDescription,
        referral.payoutMethod,
        referral.reviewNote,
        referral.payoutReference,
        referral.payoutNote
    ].filter(Boolean).map((item) => String(item).toLowerCase());
    return haystacks.some((item) => item.includes(value));
}

function normalizeReferral(referral) {
    return {
        id: String(referral._id),
        referralCode: referral.referralCode,
        status: referral.status,
        rewardGiven: Boolean(referral.rewardGiven),
        rewardAmount: Number(referral.rewardAmount || 0),
        rewardCurrency: referral.rewardCurrency || 'USD',
        reviewStatus: referral.reviewStatus || 'pending_review',
        reviewNote: referral.reviewNote || '',
        reviewedAt: referral.reviewedAt || null,
        completedAt: referral.completedAt || null,
        createdAt: referral.createdAt,
        updatedAt: referral.updatedAt,
        offerTitle: referral.offerTitle || 'Standard referral reward',
        offerDescription: referral.offerDescription || '',
        payoutStatus: referral.payoutStatus || 'not_ready',
        payoutMethod: referral.payoutMethod || 'account_credit',
        payoutReference: referral.payoutReference || '',
        payoutNote: referral.payoutNote || '',
        payoutOfferedAt: referral.payoutOfferedAt || null,
        payoutQueuedAt: referral.payoutQueuedAt || null,
        paidAt: referral.paidAt || null,
        referrer: referral.referrerId ? {
            id: String(referral.referrerId._id || ''),
            name: referral.referrerId.name || 'Unknown user',
            email: referral.referrerId.email || 'No email',
            referralCode: referral.referrerId.referralCode || null
        } : null,
        referredUser: referral.referredId ? {
            id: String(referral.referredId._id || ''),
            name: referral.referredId.name || 'Unknown user',
            email: referral.referredId.email || 'No email',
            joinedAt: referral.referredId.createdAt || null
        } : null,
        reviewedBy: referral.reviewedBy ? {
            id: String(referral.reviewedBy._id || ''),
            name: referral.reviewedBy.name || 'Admin',
            email: referral.reviewedBy.email || ''
        } : null,
        paidBy: referral.paidBy ? {
            id: String(referral.paidBy._id || ''),
            name: referral.paidBy.name || 'Admin',
            email: referral.paidBy.email || ''
        } : null
    };
}

function buildOverview(referrals) {
    const overview = {
        totalReferrals: referrals.length,
        pendingReview: 0,
        approved: 0,
        rejected: 0,
        paid: 0,
        awaitingPayout: 0,
        totalRewardOffered: 0,
        totalRewardPaid: 0,
        activeOffers: [],
        reviewQueue: [],
        payoutQueue: []
    };

    const offerMap = new Map();

    for (const referral of referrals) {
        const rewardAmount = Number(referral.rewardAmount || 0);
        if (referral.reviewStatus === 'pending_review') {
            overview.pendingReview += 1;
            overview.reviewQueue.push(normalizeReferral(referral));
        }
        if (referral.reviewStatus === 'approved') overview.approved += 1;
        if (referral.reviewStatus === 'rejected') overview.rejected += 1;
        if (referral.reviewStatus === 'paid') overview.paid += 1;

        if (['offered', 'queued'].includes(referral.payoutStatus)) {
            overview.awaitingPayout += 1;
            overview.payoutQueue.push(normalizeReferral(referral));
            overview.totalRewardOffered += rewardAmount;
        }
        if (referral.payoutStatus === 'paid') {
            overview.totalRewardPaid += rewardAmount;
        }

        const offerTitle = referral.offerTitle || 'Standard referral reward';
        const current = offerMap.get(offerTitle) || { title: offerTitle, referrals: 0, totalReward: 0 };
        current.referrals += 1;
        current.totalReward += rewardAmount;
        offerMap.set(offerTitle, current);
    }

    overview.activeOffers = Array.from(offerMap.values())
        .sort((left, right) => right.referrals - left.referrals)
        .slice(0, 5);

    overview.reviewQueue = overview.reviewQueue.slice(0, 5);
    overview.payoutQueue = overview.payoutQueue.slice(0, 5);

    return overview;
}

async function loadReferralOrFail(id) {
    const referral = await Referral.findById(id)
        .populate('referrerId', 'name email referralCode')
        .populate('referredId', 'name email createdAt')
        .populate('reviewedBy', 'name email')
        .populate('paidBy', 'name email');
    if (!referral) {
        const error = new Error('Referral not found');
        error.statusCode = 404;
        throw error;
    }
    return referral;
}

function registerAdminReferralRoutes(app) {
    app.get('/api/admin/referrals/overview', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const referrals = await Referral.find({})
                .populate('referrerId', 'name email referralCode')
                .populate('referredId', 'name email createdAt')
                .populate('reviewedBy', 'name email')
                .populate('paidBy', 'name email')
                .sort({ createdAt: -1 })
                .lean(false);

            res.json({ success: true, overview: buildOverview(referrals) });
        } catch (error) {
            log('error', 'admin_referral_overview_error', { error: error.message });
            res.status(500).json({ success: false, error: 'Failed to load referral overview', details: error.message });
        }
    });

    app.get('/api/admin/referrals', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const { q = '', page = 1, limit = 20, status = 'all', reviewStatus = 'all', payoutStatus = 'all' } = req.query;
            const referrals = await Referral.find({})
                .populate('referrerId', 'name email referralCode')
                .populate('referredId', 'name email createdAt')
                .populate('reviewedBy', 'name email')
                .populate('paidBy', 'name email')
                .sort({ createdAt: -1 });

            const filtered = referrals.filter((referral) => {
                if (status !== 'all' && referral.status !== status) return false;
                if (reviewStatus !== 'all' && referral.reviewStatus !== reviewStatus) return false;
                if (payoutStatus !== 'all' && referral.payoutStatus !== payoutStatus) return false;
                return matchesSearch(referral, q);
            });

            const paginated = paginate(filtered.map(normalizeReferral), page, limit);
            res.json({ success: true, items: paginated.items, pagination: paginated.pagination });
        } catch (error) {
            log('error', 'admin_referral_list_error', { error: error.message });
            res.status(500).json({ success: false, error: 'Failed to load referrals', details: error.message });
        }
    });

    app.post('/api/admin/referrals/:id/approve', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.MANAGE), async (req, res) => {
        try {
            const referral = await loadReferralOrFail(req.params.id);
            const rewardAmount = normalizeAmount(req.body?.rewardAmount, referral.rewardAmount || 0);
            const now = new Date();

            referral.rewardAmount = rewardAmount;
            referral.rewardCurrency = normalizeText(req.body?.rewardCurrency) || referral.rewardCurrency || 'USD';
            referral.offerTitle = normalizeText(req.body?.offerTitle) || referral.offerTitle || 'Standard referral reward';
            referral.offerDescription = normalizeText(req.body?.offerDescription) || referral.offerDescription || 'Referral reward issued after admin review and payout approval.';
            referral.payoutMethod = normalizeText(req.body?.payoutMethod) || referral.payoutMethod || 'account_credit';
            referral.reviewStatus = 'approved';
            referral.reviewNote = normalizeText(req.body?.note);
            referral.reviewedAt = now;
            referral.reviewedBy = req.adminUser._id;
            referral.status = referral.status === 'rewarded' ? 'rewarded' : 'completed';
            referral.completedAt = referral.completedAt || now;
            referral.payoutStatus = ['paid', 'queued'].includes(referral.payoutStatus) ? referral.payoutStatus : 'offered';
            referral.payoutOfferedAt = referral.payoutOfferedAt || now;
            referral.rewardGiven = referral.payoutStatus === 'paid';
            await referral.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: referral.referrerId?._id || null,
                action: 'admin.referrals.approve',
                reason: normalizeText(req.body?.reason) || 'Referral approved',
                metadata: { referralId: String(referral._id), rewardAmount: referral.rewardAmount, payoutMethod: referral.payoutMethod }
            });

            res.json({ success: true, message: 'Referral approved and payout offer prepared', item: normalizeReferral(referral) });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            log('error', 'admin_referral_approve_error', { referralId: req.params.id, error: error.message });
            res.status(statusCode).json({ success: false, error: error.message || 'Failed to approve referral' });
        }
    });

    app.post('/api/admin/referrals/:id/reject', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.MANAGE), async (req, res) => {
        try {
            const referral = await loadReferralOrFail(req.params.id);
            const now = new Date();
            referral.reviewStatus = 'rejected';
            referral.reviewNote = normalizeText(req.body?.note);
            referral.reviewedAt = now;
            referral.reviewedBy = req.adminUser._id;
            referral.payoutStatus = 'withheld';
            referral.payoutNote = normalizeText(req.body?.payoutNote) || referral.payoutNote;
            referral.rewardGiven = false;
            await referral.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: referral.referrerId?._id || null,
                action: 'admin.referrals.reject',
                reason: normalizeText(req.body?.reason) || 'Referral rejected',
                metadata: { referralId: String(referral._id) }
            });

            res.json({ success: true, message: 'Referral marked as rejected/withheld', item: normalizeReferral(referral) });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            log('error', 'admin_referral_reject_error', { referralId: req.params.id, error: error.message });
            res.status(statusCode).json({ success: false, error: error.message || 'Failed to reject referral' });
        }
    });

    app.post('/api/admin/referrals/:id/offer', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.CONFIGURE), async (req, res) => {
        try {
            const referral = await loadReferralOrFail(req.params.id);
            referral.rewardAmount = normalizeAmount(req.body?.rewardAmount, referral.rewardAmount || 0);
            referral.rewardCurrency = normalizeText(req.body?.rewardCurrency) || referral.rewardCurrency || 'USD';
            referral.offerTitle = normalizeText(req.body?.offerTitle) || referral.offerTitle || 'Standard referral reward';
            referral.offerDescription = normalizeText(req.body?.offerDescription) || referral.offerDescription || 'Referral reward issued after admin review and payout approval.';
            referral.payoutMethod = normalizeText(req.body?.payoutMethod) || referral.payoutMethod || 'account_credit';
            referral.payoutStatus = normalizeText(req.body?.queueForPayment) === 'true' ? 'queued' : 'offered';
            referral.payoutOfferedAt = referral.payoutOfferedAt || new Date();
            if (referral.payoutStatus === 'queued') referral.payoutQueuedAt = new Date();
            referral.payoutNote = normalizeText(req.body?.note);
            await referral.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: referral.referrerId?._id || null,
                action: 'admin.referrals.offer',
                reason: normalizeText(req.body?.reason) || 'Referral offer updated',
                metadata: { referralId: String(referral._id), payoutStatus: referral.payoutStatus, rewardAmount: referral.rewardAmount }
            });

            res.json({ success: true, message: 'Referral offer updated', item: normalizeReferral(referral) });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            log('error', 'admin_referral_offer_error', { referralId: req.params.id, error: error.message });
            res.status(statusCode).json({ success: false, error: error.message || 'Failed to update referral offer' });
        }
    });

    app.post('/api/admin/referrals/:id/mark-paid', requireAdminPermission(ADMIN_REFERRAL_PERMISSIONS.MANAGE), async (req, res) => {
        try {
            const referral = await loadReferralOrFail(req.params.id);
            const now = new Date();
            const payoutMethod = normalizeText(req.body?.payoutMethod) || referral.payoutMethod || 'account_credit';
            const shouldCreditAccount = payoutMethod === 'account_credit' && !referral.rewardGiven;
            let creditTransaction = null;

            if (shouldCreditAccount) {
                const referrerId = referral.referrerId?._id || referral.referrerId;
                const user = await User.findOne({ _id: referrerId, role: { $ne: 'admin' } });
                if (!user) {
                    return res.status(404).json({ success: false, error: 'Referrer account not found for account credit payout' });
                }

                user.balance = Number(user.balance || 0) + Number(referral.rewardAmount || 0);
                await user.save();

                creditTransaction = await Transaction.create({
                    userId: user._id,
                    type: 'payment',
                    status: 'completed',
                    settledAt: now,
                    transactionId: generateTransactionId(),
                    amount: Number(referral.rewardAmount || 0),
                    currency: referral.rewardCurrency || user.currency || 'USD',
                    description: `Referral reward credited for referral ${referral.referralCode}`,
                    paymentMethod: 'account_credit',
                    paymentGatewayId: null,
                    metadata: {
                        source: 'referral_reward',
                        referralId: String(referral._id),
                        referralCode: referral.referralCode,
                        recordedBy: req.adminUser.email,
                        recordedAt: now
                    }
                });
            }

            referral.reviewStatus = 'paid';
            referral.reviewedAt = referral.reviewedAt || now;
            referral.reviewedBy = referral.reviewedBy || req.adminUser._id;
            referral.status = 'rewarded';
            referral.rewardGiven = true;
            referral.completedAt = referral.completedAt || now;
            referral.payoutStatus = 'paid';
            referral.paidAt = now;
            referral.paidBy = req.adminUser._id;
            referral.payoutReference = normalizeText(req.body?.payoutReference) || creditTransaction?.transactionId || referral.payoutReference;
            referral.payoutMethod = payoutMethod;
            referral.payoutNote = normalizeText(req.body?.note);
            await referral.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: referral.referrerId?._id || null,
                action: 'admin.referrals.mark_paid',
                reason: normalizeText(req.body?.reason) || 'Referral marked paid',
                metadata: {
                    referralId: String(referral._id),
                    payoutReference: referral.payoutReference,
                    rewardAmount: referral.rewardAmount,
                    payoutMethod: referral.payoutMethod,
                    creditTransactionId: creditTransaction ? creditTransaction.transactionId : null
                }
            });

            res.json({
                success: true,
                message: referral.payoutMethod === 'account_credit'
                    ? 'Referral reward marked as paid and credited to account balance'
                    : 'Referral reward marked as paid',
                item: normalizeReferral(referral),
                transaction: creditTransaction ? {
                    id: String(creditTransaction._id),
                    transactionId: creditTransaction.transactionId,
                    amount: creditTransaction.amount,
                    currency: creditTransaction.currency,
                    status: creditTransaction.status
                } : null
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            log('error', 'admin_referral_mark_paid_error', { referralId: req.params.id, error: error.message });
            res.status(statusCode).json({ success: false, error: error.message || 'Failed to mark referral as paid' });
        }
    });
}

module.exports = registerAdminReferralRoutes;
