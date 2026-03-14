const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDoc,
    createFlagSubdoc,
    createPermissionProxy,
    createRouteTestContext,
    createSubdocCollection,
    withRouteApp
} = require('./helpers/test-kit');

const routeModulePath = 'routes/admin-billing.js';

function createBillingRouteMocks(overrides = {}) {
    const ctx = createRouteTestContext();
    const account = overrides.account || createDoc({
        _id: '507f1f77bcf86cd799439091',
        email: 'billing@test.local',
        adminNotes: [],
        internalFlags: createSubdocCollection([])
    });

    const service = {
        ADMIN_BILLING_PERMISSIONS: createPermissionProxy(),
        BILLING_NOTE_CATEGORIES: ['billing', 'support'],
        BILLING_FLAG_TYPES: ['manual_review', 'grace_period'],
        BILLING_FLAG_SEVERITIES: ['low', 'medium', 'high'],
        async getBillingOverview() { return { totalSubscribedAccounts: 1 }; },
        async getBillingAnalytics() { return { trends: [] }; },
        async getBillingRiskSummary() { return { overdueAccounts: 0 }; },
        async listAdminSubscriptions() { return { items: [{ id: 'sub-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getSubscriptionDetail() { return { id: 'sub-1' }; },
        async getAccountBillingOverview() { return { id: account._id }; },
        async getAccountEntitlements() { return { monitoring: true }; },
        async getAccountBillableRouters() { return { total: 1, items: [{ id: 'router-1' }] }; },
        async getAccountBillingActivity() { return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getGlobalBillingActivity() { return { items: [{ id: 'activity-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listInvoices() { return { items: [{ id: 'invoice-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getInvoiceDetail() { return { id: 'invoice-1' }; },
        async getAccountInvoices() { return { items: [{ id: 'invoice-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listPayments() { return { items: [{ id: 'payment-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getPaymentDetail() { return { id: 'payment-1' }; },
        async getAccountPayments() { return { items: [{ id: 'payment-1' }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async listTrials() { return { items: [{ id: account._id }], pagination: { page: 1, limit: 20, total: 1, pages: 1 } }; },
        async getBillingNotes() { return [{ body: 'note' }]; },
        async getBillingFlags() { return [{ flag: 'manual_review' }]; },
        async extendAccountTrial() { return { trialEndsAt: '2026-03-20T00:00:00.000Z' }; },
        async markBillingReviewed() { return { billingReviewedAt: '2026-03-14T00:00:00.000Z' }; },
        async suspendAccountForBilling() { return { billingSuspendedAt: '2026-03-14T00:00:00.000Z' }; },
        async reactivateAccountAfterBilling() { return { billingReactivatedAt: '2026-03-14T00:00:00.000Z' }; },
        async resendLatestInvoice() { return { _id: 'invoice-1', transactionId: 'tx-1' }; },
        async applyGracePeriod() { return { billingGracePeriodEndsAt: '2026-03-17T00:00:00.000Z' }; },
        async removeGracePeriod() { return true; },
        ...overrides.service
    };

    const userModel = {
        async findById(id) { return id === account._id ? account : null; },
        ...overrides.userModel
    };

    return {
        ctx,
        account,
        mocks: {
            'middleware/admin-auth.js': ctx.adminAuth,
            'services/admin-audit-service.js': ctx.auditService,
            'services/admin-billing-service.js': service,
            'models/User.js': userModel
        }
    };
}

test('admin billing routes enforce auth and return read payloads', async () => {
    const { mocks, account } = createBillingRouteMocks();
    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('GET', '/api/admin/billing/overview', { token: null })).response.status, 401);
        for (const path of [
            '/api/admin/billing/overview',
            '/api/admin/billing/analytics',
            '/api/admin/billing/activity',
            '/api/admin/billing/risk',
            '/api/admin/billing/subscriptions',
            '/api/admin/billing/subscriptions/sub-1',
            `/api/admin/billing/accounts/${account._id}/overview`,
            `/api/admin/billing/accounts/${account._id}/entitlements`,
            `/api/admin/billing/accounts/${account._id}/billable-routers`,
            `/api/admin/billing/accounts/${account._id}/activity`,
            '/api/admin/billing/invoices',
            '/api/admin/billing/invoices/invoice-1',
            `/api/admin/billing/accounts/${account._id}/invoices`,
            '/api/admin/billing/payments',
            '/api/admin/billing/payments/payment-1',
            `/api/admin/billing/accounts/${account._id}/payments`,
            '/api/admin/billing/trials',
            `/api/admin/billing/accounts/${account._id}/notes`,
            `/api/admin/billing/accounts/${account._id}/flags`
        ]) {
            assert.equal((await request('GET', path)).response.status, 200, path);
        }
    });
});

test('admin billing mutations validate payloads, persist notes/flags, and create audits', async () => {
    const flag = createFlagSubdoc({ _id: 'billing-flag', flag: 'manual_review', severity: 'medium' });
    const account = createDoc({
        _id: '507f1f77bcf86cd799439092',
        email: 'billing2@test.local',
        adminNotes: [],
        internalFlags: createSubdocCollection([flag])
    });
    const { mocks, ctx } = createBillingRouteMocks({ account });

    await withRouteApp({ routeModulePath, mocks }, async ({ request }) => {
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/extend-trial`, { body: { days: 0 } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/extend-trial`, { body: { days: 3, reason: 'retention' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/mark-reviewed`, { body: { reason: 'checked' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/suspend`, { body: { reason: 'overdue' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/reactivate`, { body: { reason: 'paid' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/resend-invoice`, { body: { reason: 'follow-up' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/apply-grace-period`, { body: { days: 0 } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/apply-grace-period`, { body: { days: 2, reason: 'courtesy' } })).response.status, 200);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/remove-grace-period`, { body: { reason: 'ended' } })).response.status, 200);

        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/notes`, { body: {} })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/notes`, { body: { body: 'x', category: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/notes`, { body: { body: 'Call customer', category: 'billing', pinned: true } })).response.status, 200);
        assert.equal(account.adminNotes.length, 1);

        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/flags`, { body: { flag: 'invalid' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/flags`, { body: { flag: 'manual_review', severity: 'critical' } })).response.status, 400);
        assert.equal((await request('POST', `/api/admin/billing/accounts/${account._id}/flags`, { body: { flag: 'grace_period', severity: 'high' } })).response.status, 200);
        assert.equal((await request('DELETE', `/api/admin/billing/accounts/${account._id}/flags/billing-flag`, { body: { reason: 'cleared' } })).response.status, 200);
        assert.equal(flag.deleted, true);
        assert.ok(ctx.auditCalls.length >= 9);
    });
});
