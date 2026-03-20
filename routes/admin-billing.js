const crypto = require('crypto');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const {
    ADMIN_BILLING_PERMISSIONS,
    BILLING_NOTE_CATEGORIES,
    BILLING_FLAG_TYPES,
    BILLING_FLAG_SEVERITIES,
    getBillingOverview,
    getBillingAnalytics,
    getBillingRiskSummary,
    listAdminSubscriptions,
    getSubscriptionDetail,
    getAccountBillingOverview,
    getAccountEntitlements,
    getAccountBillableRouters,
    getAccountBillingActivity,
    getGlobalBillingActivity,
    listInvoices,
    getInvoiceDetail,
    getAccountInvoices,
    listPayments,
    getPaymentDetail,
    getAccountPayments,
    listTrials,
    getBillingNotes,
    getBillingFlags,
    extendAccountTrial,
    markBillingReviewed,
    suspendAccountForBilling,
    reactivateAccountAfterBilling,
    resendLatestInvoice,
    applyGracePeriod,
    removeGracePeriod
} = require('../services/admin-billing-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function validateDays(value, fallback = null) {
    const days = Number(value);
    if (!Number.isFinite(days) || days < 1) {
        return fallback;
    }
    return Math.floor(days);
}

function normalizeAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }
    return amount;
}

function generateTransactionId(prefix = '') {
    return `${prefix}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

async function getAccountOr404(req, res) {
    const user = await User.findById(req.params.accountId);
    if (!user) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return null;
    }
    return user;
}

async function audit(req, targetUserId, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId,
        action,
        reason,
        metadata
    });
}

function registerAdminBillingRoutes(app) {
    app.get('/api/admin/billing/overview', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const overview = await getBillingOverview();
            return res.json({ success: true, overview });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing overview', details: error.message });
        }
    });

    app.get('/api/admin/billing/analytics', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const analytics = await getBillingAnalytics(req.query || {});
            return res.json({ success: true, analytics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing analytics', details: error.message });
        }
    });

    app.get('/api/admin/billing/activity', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const accountId = req.query.accountId;
            const activity = accountId
                ? await getAccountBillingActivity(accountId, req.query || {})
                : await getGlobalBillingActivity(req.query || {});
            if (!activity) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: activity.items, pagination: activity.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing activity', details: error.message });
        }
    });

    app.get('/api/admin/billing/risk', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const risk = await getBillingRiskSummary();
            return res.json({ success: true, risk });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing risk summary', details: error.message });
        }
    });

    app.get('/api/admin/billing/subscriptions', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const result = await listAdminSubscriptions(req.query || {});
            return res.json({ success: true, items: result.items, pagination: result.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load subscriptions', details: error.message });
        }
    });

    app.get('/api/admin/billing/subscriptions/:subscriptionId', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const detail = await getSubscriptionDetail(req.params.subscriptionId);
            if (!detail) {
                return res.status(404).json({ success: false, error: 'Subscription not found' });
            }
            return res.json({ success: true, data: detail });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load subscription detail', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/overview', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const detail = await getAccountBillingOverview(req.params.accountId);
            if (!detail) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, data: detail });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load account billing overview', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/entitlements', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_ENTITLEMENTS), async (req, res) => {
        try {
            const entitlements = await getAccountEntitlements(req.params.accountId);
            if (!entitlements) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, entitlements });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load account entitlements', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/billable-routers', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const data = await getAccountBillableRouters(req.params.accountId);
            if (!data) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, billableRouters: data });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billable router summary', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/activity', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const data = await getAccountBillingActivity(req.params.accountId, req.query || {});
            if (!data) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load account billing activity', details: error.message });
        }
    });

    app.get('/api/admin/billing/invoices', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_INVOICES), async (req, res) => {
        try {
            const data = await listInvoices(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load invoices', details: error.message });
        }
    });

    app.post('/api/admin/billing/invoices', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.CREATE_INVOICE), async (req, res) => {
        try {
            const { accountId, description, currency = 'USD', dueDate } = req.body || {};
            const amount = normalizeAmount(req.body?.amount);
            if (!accountId || !description || !String(description).trim() || !amount) {
                return res.status(400).json({ success: false, error: 'accountId, amount, and description are required' });
            }
            const user = await User.findById(accountId);
            if (!user) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            const subscription = await Subscription.findOne({ userId: accountId }).sort({ createdAt: -1 });
            const invoice = await Transaction.create({
                userId: accountId,
                type: 'invoice',
                status: 'pending',
                transactionId: generateTransactionId(),
                amount,
                currency,
                description: String(description).trim(),
                dueDate: dueDate ? new Date(dueDate) : null,
                subscriptionId: subscription?._id || null,
                metadata: {
                    createdBy: req.adminUser.email,
                    createdAt: new Date(),
                    reason: normalizeReason(req.body?.reason)
                }
            });
            await audit(req, user._id, 'admin_create_invoice', normalizeReason(req.body?.reason), { invoiceId: invoice._id, transactionId: invoice.transactionId });
            return res.json({
                success: true,
                message: 'Invoice created',
                invoice: {
                    id: String(invoice._id),
                    transactionId: invoice.transactionId,
                    amount: invoice.amount,
                    currency: invoice.currency,
                    status: invoice.status,
                    dueDate: invoice.dueDate || null,
                    createdAt: invoice.createdAt
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create invoice', details: error.message });
        }
    });

    app.get('/api/admin/billing/invoices/:invoiceId', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_INVOICES), async (req, res) => {
        try {
            const invoice = await getInvoiceDetail(req.params.invoiceId);
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'Invoice not found' });
            }
            return res.json({ success: true, invoice });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load invoice detail', details: error.message });
        }
    });

    app.get('/api/admin/billing/invoices/:invoiceId/pdf', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_INVOICES), async (req, res) => {
        try {
            const invoice = await Transaction.findOne({ _id: req.params.invoiceId, type: 'invoice' }).lean();
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'Invoice not found' });
            }
            const user = await User.findById(invoice.userId).lean();
            return res.json({
                success: true,
                invoiceData: {
                    ispName: 'Blackie Networks',
                    transactionId: invoice.transactionId,
                    subscriberName: user?.name || 'Unknown subscriber',
                    subscriberEmail: user?.email || 'Unknown email',
                    amount: invoice.amount,
                    currency: invoice.currency || 'USD',
                    status: invoice.status,
                    description: invoice.description,
                    dueDate: invoice.dueDate || null,
                    createdAt: invoice.createdAt
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to prepare invoice download', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/invoices', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_INVOICES), async (req, res) => {
        try {
            const data = await getAccountInvoices(req.params.accountId, req.query || {});
            if (!data) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load account invoices', details: error.message });
        }
    });

    app.get('/api/admin/billing/payments', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_PAYMENTS), async (req, res) => {
        try {
            const data = await listPayments(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load payments', details: error.message });
        }
    });

    app.post('/api/admin/billing/payments', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.RECORD_PAYMENT), async (req, res) => {
        try {
            const { accountId, description, currency = 'USD', paymentMethod, reference } = req.body || {};
            const amount = normalizeAmount(req.body?.amount);
            if (!accountId || !description || !String(description).trim() || !paymentMethod || !amount) {
                return res.status(400).json({ success: false, error: 'accountId, amount, description, and paymentMethod are required' });
            }
            const user = await User.findById(accountId);
            if (!user) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            const subscription = await Subscription.findOne({ userId: accountId, status: { $in: ['trial', 'active', 'past_due'] } }).sort({ createdAt: -1 });
            const transaction = await Transaction.create({
                userId: accountId,
                type: 'payment',
                status: 'completed',
                settledAt: new Date(),
                transactionId: generateTransactionId(),
                amount,
                currency,
                description: String(description).trim(),
                paymentMethod,
                paymentGatewayId: reference || null,
                subscriptionId: subscription?._id || null,
                metadata: {
                    recordedBy: req.adminUser.email,
                    recordedAt: new Date(),
                    reference: reference || null
                }
            });
            await audit(req, user._id, 'admin_record_payment', normalizeReason(req.body?.reason), { transactionId: transaction.transactionId, amount: transaction.amount, paymentMethod });
            return res.json({
                success: true,
                message: 'Payment recorded',
                transaction: {
                    id: String(transaction._id),
                    transactionId: transaction.transactionId,
                    amount: transaction.amount,
                    currency: transaction.currency,
                    status: transaction.status,
                    createdAt: transaction.createdAt
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to record payment', details: error.message });
        }
    });

    app.get('/api/admin/billing/payments/:paymentId', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_PAYMENTS), async (req, res) => {
        try {
            const payment = await getPaymentDetail(req.params.paymentId);
            if (!payment) {
                return res.status(404).json({ success: false, error: 'Payment not found' });
            }
            return res.json({ success: true, payment });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load payment detail', details: error.message });
        }
    });

    app.post('/api/admin/billing/refunds', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.ISSUE_REFUND), async (req, res) => {
        try {
            const { accountId, originalTransactionId, description, currency = 'USD' } = req.body || {};
            const amount = normalizeAmount(req.body?.amount);
            const reason = normalizeReason(req.body?.reason);
            if (!accountId || !description || !String(description).trim() || !amount || !reason) {
                return res.status(400).json({ success: false, error: 'accountId, amount, description, and reason are required' });
            }
            const user = await User.findById(accountId);
            if (!user) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            let originalTransaction = null;
            if (originalTransactionId) {
                originalTransaction = await Transaction.findById(originalTransactionId);
                if (!originalTransaction || String(originalTransaction.userId) !== String(accountId)) {
                    return res.status(400).json({ success: false, error: 'Original transaction does not belong to this account' });
                }
            }
            const refund = await Transaction.create({
                userId: accountId,
                type: 'refund',
                status: 'completed',
                settledAt: new Date(),
                transactionId: generateTransactionId('RFD-'),
                amount,
                currency,
                description: String(description).trim(),
                paymentMethod: originalTransaction?.paymentMethod || 'manual',
                paymentGatewayId: originalTransaction?.paymentGatewayId || null,
                subscriptionId: originalTransaction?.subscriptionId || null,
                metadata: {
                    originalTransactionId: originalTransaction ? String(originalTransaction._id) : null,
                    recordedBy: req.adminUser.email,
                    recordedAt: new Date(),
                    reason
                }
            });
            await audit(req, user._id, 'admin_issue_refund', reason, { refundId: refund._id, transactionId: refund.transactionId, amount: refund.amount });
            return res.json({
                success: true,
                message: 'Refund recorded',
                refund: {
                    id: String(refund._id),
                    transactionId: refund.transactionId,
                    amount: refund.amount,
                    currency: refund.currency,
                    status: refund.status,
                    createdAt: refund.createdAt
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to record refund', details: error.message });
        }
    });

    app.get('/api/admin/billing/reports/revenue', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_OVERVIEW), async (req, res) => {
        try {
            const windowValue = String(req.query?.window || '30d').toLowerCase();
            const groupBy = String(req.query?.groupBy || 'day').toLowerCase();
            const dayMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
            const days = dayMap[windowValue] || 30;
            const start = new Date();
            start.setDate(start.getDate() - days);
            const transactions = await Transaction.find({ createdAt: { $gte: start } }).sort({ createdAt: 1 }).lean();
            const users = await User.find({ _id: { $in: [...new Set(transactions.map((tx) => String(tx.userId)).filter(Boolean))] } }).lean();
            const usersById = new Map(users.map((user) => [String(user._id), user]));
            const seriesMap = new Map();
            const revenueByUser = new Map();
            const bucketKey = (date) => {
                const d = new Date(date);
                if (groupBy === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
                if (groupBy === 'week') {
                    const temp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
                    const day = temp.getUTCDay() || 7;
                    temp.setUTCDate(temp.getUTCDate() + 4 - day);
                    const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
                    const week = Math.ceil((((temp - yearStart) / 86400000) + 1) / 7);
                    return `${temp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
                }
                return d.toISOString().slice(0, 10);
            };

            let totalRevenue = 0;
            let totalInvoiced = 0;
            let failedPayments = 0;
            let refundTotal = 0;

            for (const tx of transactions) {
                const key = bucketKey(tx.createdAt);
                if (!seriesMap.has(key)) {
                    seriesMap.set(key, { date: key, revenue: 0, invoices: 0, failedPayments: 0 });
                }
                const bucket = seriesMap.get(key);
                if (tx.type === 'payment' && tx.status === 'completed') {
                    bucket.revenue += tx.amount || 0;
                    totalRevenue += tx.amount || 0;
                    revenueByUser.set(String(tx.userId), (revenueByUser.get(String(tx.userId)) || 0) + (tx.amount || 0));
                }
                if (tx.type === 'invoice') {
                    bucket.invoices += tx.amount || 0;
                    totalInvoiced += tx.amount || 0;
                }
                if (tx.type === 'payment' && tx.status === 'failed') {
                    bucket.failedPayments += 1;
                    failedPayments += 1;
                }
                if (tx.type === 'refund') {
                    refundTotal += tx.amount || 0;
                }
            }

            const topAccounts = [...revenueByUser.entries()]
                .map(([accountId, revenue]) => ({
                    accountId,
                    name: usersById.get(accountId)?.name || 'Unknown',
                    email: usersById.get(accountId)?.email || 'Unknown',
                    revenue
                }))
                .sort((a, b) => b.revenue - a.revenue)
                .slice(0, 5);

            return res.json({
                success: true,
                report: {
                    window: windowValue,
                    groupBy,
                    totalRevenue,
                    totalInvoiced,
                    failedPayments,
                    refundTotal,
                    series: [...seriesMap.values()],
                    topAccounts
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load revenue report', details: error.message });
        }
    });

    app.get('/api/admin/billing/reports/outstanding', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_INVOICES), async (req, res) => {
        try {
            const invoices = await Transaction.find({ type: 'invoice', status: 'pending' }).sort({ createdAt: 1 }).lean();
            const grouped = new Map();
            for (const invoice of invoices) {
                const key = String(invoice.userId);
                if (!grouped.has(key)) {
                    grouped.set(key, { accountId: key, totalOutstanding: 0, invoiceCount: 0, oldestInvoiceDate: invoice.createdAt || null });
                }
                const item = grouped.get(key);
                item.totalOutstanding += invoice.amount || 0;
                item.invoiceCount += 1;
                if (!item.oldestInvoiceDate || new Date(invoice.createdAt) < new Date(item.oldestInvoiceDate)) {
                    item.oldestInvoiceDate = invoice.createdAt || null;
                }
            }
            const users = await User.find({ _id: { $in: [...grouped.keys()] } }).lean();
            const usersById = new Map(users.map((user) => [String(user._id), user]));
            const accounts = [...grouped.values()]
                .map((item) => ({
                    accountId: item.accountId,
                    name: usersById.get(item.accountId)?.name || 'Unknown',
                    email: usersById.get(item.accountId)?.email || 'Unknown',
                    totalOutstanding: item.totalOutstanding,
                    invoiceCount: item.invoiceCount,
                    oldestInvoiceDate: item.oldestInvoiceDate
                }))
                .sort((a, b) => b.totalOutstanding - a.totalOutstanding);
            return res.json({
                success: true,
                report: {
                    totalOutstanding: accounts.reduce((sum, item) => sum + item.totalOutstanding, 0),
                    accountCount: accounts.length,
                    accounts
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load outstanding balances report', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/payments', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_PAYMENTS), async (req, res) => {
        try {
            const data = await getAccountPayments(req.params.accountId, req.query || {});
            if (!data) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load account payments', details: error.message });
        }
    });

    app.get('/api/admin/billing/trials', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_TRIALS), async (req, res) => {
        try {
            const data = await listTrials(req.query || {});
            return res.json({ success: true, items: data.items, pagination: data.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load trial accounts', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/extend-trial', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_TRIALS), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const days = validateDays(req.body?.days);
            if (!days) {
                return res.status(400).json({ success: false, error: 'days must be a positive integer' });
            }
            const reason = normalizeReason(req.body?.reason);
            const updated = await extendAccountTrial(user._id, days, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.extend_trial', reason, { days, trialEndsAt: updated.trialEndsAt });
            return res.json({ success: true, message: 'Trial extended successfully', trialEndsAt: updated.trialEndsAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to extend trial', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/mark-reviewed', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const reason = normalizeReason(req.body?.reason);
            const updated = await markBillingReviewed(user._id, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.mark_reviewed', reason, { billingReviewedAt: updated.billingReviewedAt });
            return res.json({ success: true, message: 'Billing marked as reviewed', billingReviewedAt: updated.billingReviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark billing reviewed', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/suspend', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const reason = normalizeReason(req.body?.reason) || 'Suspended for billing';
            const updated = await suspendAccountForBilling(user._id, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.suspend', reason, { billingSuspendedAt: updated.billingSuspendedAt });
            return res.json({ success: true, message: 'Account suspended for billing', billingSuspendedAt: updated.billingSuspendedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to suspend account', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/reactivate', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const reason = normalizeReason(req.body?.reason);
            const updated = await reactivateAccountAfterBilling(user._id, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.reactivate', reason, { billingReactivatedAt: updated.billingReactivatedAt });
            return res.json({ success: true, message: 'Account reactivated after billing resolution', billingReactivatedAt: updated.billingReactivatedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reactivate account', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/resend-invoice', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.RESEND_INVOICE), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const reason = normalizeReason(req.body?.reason);
            const invoice = await resendLatestInvoice(user._id);
            await audit(req, user._id, 'admin.billing.resend_invoice', reason, { invoiceId: invoice._id, transactionId: invoice.transactionId });
            return res.json({ success: true, message: 'Billing reminder sent successfully', invoiceId: invoice._id, transactionId: invoice.transactionId });
        } catch (error) {
            if (error.code === 'INVOICE_NOT_FOUND') {
                return res.status(404).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, error: 'Failed to resend invoice', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/apply-grace-period', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_GRACE_PERIOD), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const days = validateDays(req.body?.days);
            if (!days) {
                return res.status(400).json({ success: false, error: 'days must be a positive integer' });
            }
            const reason = normalizeReason(req.body?.reason);
            const updated = await applyGracePeriod(user._id, days, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.apply_grace_period', reason, { days, billingGracePeriodEndsAt: updated.billingGracePeriodEndsAt });
            return res.json({ success: true, message: 'Grace period applied successfully', billingGracePeriodEndsAt: updated.billingGracePeriodEndsAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to apply grace period', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/remove-grace-period', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.MANAGE_GRACE_PERIOD), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const reason = normalizeReason(req.body?.reason);
            await removeGracePeriod(user._id, req.adminUser.email, reason);
            await audit(req, user._id, 'admin.billing.remove_grace_period', reason, {});
            return res.json({ success: true, message: 'Grace period removed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove grace period', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/notes', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.VIEW_SUBSCRIPTIONS), async (req, res) => {
        try {
            const notes = await getBillingNotes(req.params.accountId);
            if (!notes) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing notes', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/notes', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.ADD_NOTE), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !BILLING_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid billing note category', categories: BILLING_NOTE_CATEGORIES });
            }
            const reason = normalizeReason(req.body?.reason);
            user.adminNotes.push({
                body: String(req.body.body).trim(),
                category: req.body.category || 'billing',
                pinned: Boolean(req.body.pinned),
                author: req.adminUser.email
            });
            await user.save();
            await audit(req, user._id, 'admin.billing.add_note', reason, { category: req.body.category || 'billing', pinned: Boolean(req.body.pinned) });
            return res.json({ success: true, message: 'Billing note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add billing note', details: error.message });
        }
    });

    app.get('/api/admin/billing/accounts/:accountId/flags', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const flags = await getBillingFlags(req.params.accountId);
            if (!flags) {
                return res.status(404).json({ success: false, error: 'Account not found' });
            }
            return res.json({ success: true, items: flags });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load billing flags', details: error.message });
        }
    });

    app.post('/api/admin/billing/accounts/:accountId/flags', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            if (!req.body?.flag || !BILLING_FLAG_TYPES.includes(req.body.flag)) {
                return res.status(400).json({ success: false, error: 'Invalid billing flag type', flagTypes: BILLING_FLAG_TYPES });
            }
            if (req.body.severity && !BILLING_FLAG_SEVERITIES.includes(req.body.severity)) {
                return res.status(400).json({ success: false, error: 'Invalid billing flag severity', severities: BILLING_FLAG_SEVERITIES });
            }
            const reason = normalizeReason(req.body?.reason);
            user.internalFlags.push({
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || '',
                createdBy: req.adminUser.email
            });
            await user.save();
            await audit(req, user._id, 'admin.billing.add_flag', reason, { flag: req.body.flag, severity: req.body.severity || 'medium' });
            return res.json({ success: true, message: 'Billing flag added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add billing flag', details: error.message });
        }
    });

    app.delete('/api/admin/billing/accounts/:accountId/flags/:flagId', requireAdminPermission(ADMIN_BILLING_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const user = await getAccountOr404(req, res);
            if (!user) return;
            const flag = user.internalFlags.id(req.params.flagId);
            if (!flag) {
                return res.status(404).json({ success: false, error: 'Flag not found' });
            }
            const reason = normalizeReason(req.body?.reason);
            flag.deleteOne();
            await user.save();
            await audit(req, user._id, 'admin.billing.remove_flag', reason, { flagId: req.params.flagId });
            return res.json({ success: true, message: 'Billing flag removed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove billing flag', details: error.message });
        }
    });
}

module.exports = registerAdminBillingRoutes;
