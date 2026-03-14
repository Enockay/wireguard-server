const User = require('../models/User');
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
