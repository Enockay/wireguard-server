const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const MikrotikRouter = require('../models/MikrotikRouter');
const AdminAuditLog = require('../models/AdminAuditLog');
const { sendBillingReminderEmail } = require('./email-service');
const { summarizeSubscription, normalizeNote, normalizeFlag } = require('./admin-user-service');
const { PRICING } = require('./billing-service');

const ADMIN_BILLING_PERMISSIONS = {
    VIEW: 'admin.billing.view',
    VIEW_OVERVIEW: 'admin.billing.view_overview',
    VIEW_SUBSCRIPTIONS: 'admin.billing.view_subscriptions',
    VIEW_INVOICES: 'admin.billing.view_invoices',
    VIEW_PAYMENTS: 'admin.billing.view_payments',
    VIEW_ENTITLEMENTS: 'admin.billing.view_entitlements',
    MANAGE_TRIALS: 'admin.billing.manage_trials',
    MANAGE_STATUS: 'admin.billing.manage_status',
    MANAGE_GRACE_PERIOD: 'admin.billing.manage_grace_period',
    ADD_NOTE: 'admin.billing.add_note',
    FLAG: 'admin.billing.flag',
    RESEND_INVOICE: 'admin.billing.resend_invoice',
    APPLY_ADJUSTMENT: 'admin.billing.apply_adjustment',
    EXPORT: 'admin.billing.export'
};

const BILLING_NOTE_CATEGORIES = ['billing', 'payment', 'subscription', 'overdue', 'support', 'finance_review', 'grace_period', 'adjustment', 'follow_up'];
const BILLING_FLAG_TYPES = ['overdue_high_priority', 'manual_review', 'grace_period', 'disputed', 'VIP_billing', 'payment_failure_watch', 'suspension_pending'];
const BILLING_FLAG_SEVERITIES = ['low', 'medium', 'high'];

function toDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function getWindowConfig(window = '30d') {
    const value = String(window || '30d').toLowerCase();
    if (value === '7d') return { key: '7d', ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    if (value === '90d') return { key: '90d', ms: 90 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 };
    return { key: '30d', ms: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
}

function createTrendBuckets(config) {
    const now = Date.now();
    const start = now - config.ms;
    const buckets = [];
    for (let ts = start; ts <= now; ts += config.bucketMs) {
        buckets.push({
            timestamp: new Date(ts).toISOString(),
            subscriptionsCreated: 0,
            invoicesCompleted: 0,
            paymentsCompleted: 0,
            paymentFailures: 0,
            cancellations: 0
        });
    }
    return buckets;
}

function addToTrendBuckets(buckets, date, key, bucketMs) {
    if (!date) return;
    const time = new Date(date).getTime();
    if (Number.isNaN(time)) return;
    const first = new Date(buckets[0].timestamp).getTime();
    const index = Math.floor((time - first) / bucketMs);
    if (index < 0 || index >= buckets.length) return;
    buckets[index][key] += 1;
}

function isGracePeriodActive(user) {
    return Boolean(user.billingGracePeriodEndsAt && new Date(user.billingGracePeriodEndsAt) > new Date());
}

function isTrialEndingSoon(date) {
    return Boolean(date && new Date(date) > new Date() && (new Date(date).getTime() - Date.now()) <= 3 * 24 * 60 * 60 * 1000);
}

function isBillableSubscription(subscription) {
    return subscription.planType === 'monthly' && ['active', 'past_due', 'trial'].includes(subscription.status);
}

function normalizeTransaction(transaction, user = null, subscription = null) {
    return {
        id: String(transaction._id),
        transactionId: transaction.transactionId,
        type: transaction.type,
        amount: transaction.amount,
        currency: transaction.currency || 'USD',
        description: transaction.description,
        status: transaction.status,
        paymentMethod: transaction.paymentMethod || null,
        paymentGatewayId: transaction.paymentGatewayId || null,
        dueDate: transaction.dueDate || null,
        settledAt: transaction.settledAt || null,
        failureReason: transaction.failureReason || null,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        account: user ? {
            id: String(user._id),
            name: user.name,
            email: user.email
        } : null,
        subscription: subscription ? {
            id: String(subscription._id),
            status: subscription.status,
            planType: subscription.planType
        } : null,
        metadata: transaction.metadata || {}
    };
}

function buildEntitlements(user, routers, subscriptions) {
    const summary = summarizeSubscription(subscriptions);
    const gracePeriodActive = isGracePeriodActive(user);
    const suspendedForBilling = Boolean(user.billingSuspendedAt && !user.isActive);
    const overdue = summary.overdueCount > 0;

    return {
        routerManagementEnabled: user.isActive,
        publicAccessPortsEnabled: user.isActive && routers.length > 0,
        monitoringEnabled: user.isActive && routers.length > 0,
        supportTier: user.supportTier || 'standard',
        analyticsAccessEnabled: user.isActive,
        apiAccessEnabled: false,
        trialFeaturesEnabled: Boolean(user.trialEndsAt && new Date(user.trialEndsAt) > new Date()),
        billableRouters: subscriptions.filter((subscription) => isBillableSubscription(subscription)).length,
        activeRouters: routers.filter((router) => ['pending', 'active', 'offline'].includes(router.status)).length,
        billingHold: overdue && !gracePeriodActive,
        gracePeriodActive,
        gracePeriodEndsAt: user.billingGracePeriodEndsAt || null,
        suspendedForBilling,
        accountOperationalState: suspendedForBilling ? 'restricted' : (overdue && !gracePeriodActive ? 'at_risk' : 'enabled')
    };
}

function buildBillableRouterItems(routers, subscriptionsByRouterId) {
    return routers.map((router) => {
        const subscription = subscriptionsByRouterId.get(String(router._id)) || null;
        const billable = Boolean(subscription && isBillableSubscription(subscription));
        let reason = 'No subscription linked';
        if (subscription) {
            if (subscription.planType === 'trial') reason = 'Covered by trial';
            else if (subscription.status === 'canceled' || subscription.status === 'expired') reason = `Excluded because subscription is ${subscription.status}`;
            else if (subscription.planType === 'monthly') reason = 'Counts toward monthly billing';
        }

        return {
            router: {
                id: String(router._id),
                name: router.name,
                status: router.status,
                createdAt: router.createdAt
            },
            subscription: subscription ? {
                id: String(subscription._id),
                status: subscription.status,
                planType: subscription.planType,
                pricePerMonth: subscription.pricePerMonth,
                nextBillingDate: subscription.nextBillingDate || null
            } : null,
            countedTowardBilling: billable,
            reason
        };
    });
}

async function loadBillingDataset() {
    const [users, routers, subscriptions, transactions, auditLogs] = await Promise.all([
        User.find({}).lean(),
        MikrotikRouter.find({}).lean(),
        Subscription.find({}).sort({ createdAt: -1 }).lean(),
        Transaction.find({}).sort({ createdAt: -1 }).lean(),
        AdminAuditLog.find({ action: /^admin\.(billing|users)\./ })
            .populate('actorUserId', 'name email')
            .sort({ createdAt: -1 })
            .lean()
    ]);

    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const routersByUser = new Map();
    const subscriptionsByUser = new Map();
    const transactionsByUser = new Map();
    const subscriptionsById = new Map(subscriptions.map((subscription) => [String(subscription._id), subscription]));
    const subscriptionsByRouterId = new Map(subscriptions.map((subscription) => [String(subscription.routerId), subscription]));

    for (const router of routers) {
        const key = String(router.userId);
        if (!routersByUser.has(key)) routersByUser.set(key, []);
        routersByUser.get(key).push(router);
    }
    for (const subscription of subscriptions) {
        const key = String(subscription.userId);
        if (!subscriptionsByUser.has(key)) subscriptionsByUser.set(key, []);
        subscriptionsByUser.get(key).push(subscription);
    }
    for (const transaction of transactions) {
        const key = String(transaction.userId);
        if (!transactionsByUser.has(key)) transactionsByUser.set(key, []);
        transactionsByUser.get(key).push(transaction);
    }

    return {
        users,
        routers,
        subscriptions,
        transactions,
        auditLogs,
        usersById,
        routersByUser,
        subscriptionsByUser,
        transactionsByUser,
        subscriptionsById,
        subscriptionsByRouterId
    };
}

function buildAccountSummary(user, bundle) {
    const routers = bundle.routersByUser.get(String(user._id)) || [];
    const subscriptions = bundle.subscriptionsByUser.get(String(user._id)) || [];
    const transactions = bundle.transactionsByUser.get(String(user._id)) || [];
    const summary = summarizeSubscription(subscriptions);
    const pendingInvoices = transactions.filter((tx) => tx.type === 'invoice' && tx.status === 'pending');
    const failedPayments = transactions.filter((tx) => tx.type === 'payment' && tx.status === 'failed');
    const lastPayment = transactions.find((tx) => tx.type === 'payment' || tx.type === 'invoice') || null;

    return {
        account: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            accountStatus: user.isActive ? 'active' : 'suspended',
            currency: user.currency || 'USD',
            balance: user.balance || 0
        },
        subscriptionSummary: {
            currentPlan: summary.planType || summary.status,
            subscriptionStatus: summary.status,
            trialStatus: user.trialEndsAt && new Date(user.trialEndsAt) > new Date() ? 'trial' : 'standard',
            billableRouters: summary.billableRouters,
            routersCount: routers.length,
            priceSummary: summary.monthlyValue,
            billingCycle: summary.planType === 'trial' ? 'trial' : 'monthly',
            nextBillingDate: summary.nextBillingDate,
            overdue: summary.overdueCount > 0,
            gracePeriodActive: isGracePeriodActive(user),
            gracePeriodEndsAt: user.billingGracePeriodEndsAt || null,
            suspendedForBilling: Boolean(user.billingSuspendedAt && !user.isActive),
            trialEndingSoon: isTrialEndingSoon(user.trialEndsAt) || summary.trialEndingSoon
        },
        invoices: {
            openCount: pendingInvoices.length,
            lastInvoiceStatus: pendingInvoices[0]?.status || null
        },
        payments: {
            failedCount: failedPayments.length,
            lastPaymentStatus: lastPayment?.status || null,
            lastPaymentDate: lastPayment?.settledAt || lastPayment?.createdAt || null
        }
    };
}

function buildSubscriptionListItem(subscription, bundle) {
    const user = bundle.usersById.get(String(subscription.userId));
    const accountSummary = user ? buildAccountSummary(user, bundle) : null;
    const accountTransactions = bundle.transactionsByUser.get(String(subscription.userId)) || [];
    const lastPayment = accountTransactions.find((tx) => tx.type === 'payment' || tx.type === 'invoice') || null;
    const openInvoiceCount = accountTransactions.filter((tx) => tx.type === 'invoice' && tx.status === 'pending').length;

    return {
        id: String(subscription._id),
        account: accountSummary?.account || null,
        subscriptionId: String(subscription._id),
        planName: subscription.planType,
        subscriptionStatus: subscription.status,
        trialStatus: subscription.isTrial?.() ? 'trial' : (subscription.planType === 'trial' ? 'trial' : 'standard'),
        billableRouterCount: accountSummary?.subscriptionSummary.billableRouters || 0,
        priceSummary: subscription.pricePerMonth || 0,
        billingCycle: subscription.planType === 'trial' ? 'trial' : 'monthly',
        nextBillingDate: subscription.nextBillingDate || null,
        overdue: subscription.status === 'past_due',
        lastPaymentStatus: lastPayment?.status || null,
        openInvoiceCount,
        accountStatus: accountSummary?.account.accountStatus || 'unknown',
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt
    };
}

async function getBillingOverview() {
    const bundle = await loadBillingDataset();
    const uniqueSubscribedAccounts = new Set(bundle.subscriptions.map((subscription) => String(subscription.userId)));
    const overdueUsers = new Set(bundle.subscriptions.filter((subscription) => subscription.status === 'past_due').map((subscription) => String(subscription.userId)));
    const trialUsers = new Set(bundle.subscriptions.filter((subscription) => subscription.planType === 'trial').map((subscription) => String(subscription.userId)));
    const activePaidUsers = new Set(bundle.subscriptions.filter((subscription) => subscription.planType === 'monthly' && subscription.status === 'active').map((subscription) => String(subscription.userId)));

    return {
        totalSubscribedAccounts: uniqueSubscribedAccounts.size,
        trialAccounts: trialUsers.size,
        activePaidAccounts: activePaidUsers.size,
        overdueAccounts: overdueUsers.size,
        canceledAccounts: new Set(bundle.subscriptions.filter((subscription) => subscription.status === 'canceled').map((subscription) => String(subscription.userId))).size,
        expiredAccounts: new Set(bundle.subscriptions.filter((subscription) => subscription.status === 'expired').map((subscription) => String(subscription.userId))).size,
        accountsInGracePeriod: bundle.users.filter((user) => isGracePeriodActive(user)).length,
        totalActiveBillableRouters: bundle.subscriptions.filter((subscription) => isBillableSubscription(subscription)).length,
        estimatedMRR: bundle.subscriptions.filter((subscription) => subscription.planType === 'monthly' && ['active', 'past_due'].includes(subscription.status)).reduce((sum, subscription) => sum + (subscription.pricePerMonth || 0), 0),
        overdueInvoiceCount: bundle.transactions.filter((tx) => tx.type === 'invoice' && tx.status === 'pending').length,
        openInvoiceCount: bundle.transactions.filter((tx) => tx.type === 'invoice' && tx.status === 'pending').length,
        failedPaymentCount: bundle.transactions.filter((tx) => tx.type === 'payment' && tx.status === 'failed').length,
        trialsEndingSoon: bundle.users.filter((user) => isTrialEndingSoon(user.trialEndsAt)).length,
        accountsSuspendedForBilling: bundle.users.filter((user) => user.billingSuspendedAt && !user.isActive).length,
        accountsReactivatedRecently: bundle.users.filter((user) => user.billingReactivatedAt && (Date.now() - new Date(user.billingReactivatedAt).getTime()) <= 30 * 24 * 60 * 60 * 1000).length,
        lastBillingSyncAt: bundle.subscriptions.length ? bundle.subscriptions.reduce((latest, subscription) => {
            const value = new Date(subscription.updatedAt || subscription.createdAt).getTime();
            return !latest || value > latest ? value : latest;
        }, 0) ? new Date(bundle.subscriptions.reduce((latest, subscription) => {
            const value = new Date(subscription.updatedAt || subscription.createdAt).getTime();
            return !latest || value > latest ? value : latest;
        }, 0)).toISOString() : null : null,
        pricing: {
            routerMonthlyPrice: PRICING.ROUTER_MONTHLY_PRICE,
            trialDays: PRICING.TRIAL_DAYS
        }
    };
}

async function listAdminSubscriptions(query = {}) {
    const bundle = await loadBillingDataset();
    let items = bundle.subscriptions.map((subscription) => buildSubscriptionListItem(subscription, bundle));
    const q = String(query.q || '').trim().toLowerCase();
    const createdFrom = toDateOrNull(query.createdFrom);
    const createdTo = toDateOrNull(query.createdTo);
    const nextBillingFrom = toDateOrNull(query.nextBillingFrom);
    const nextBillingTo = toDateOrNull(query.nextBillingTo);

    items = items.filter((item) => {
        if (q) {
            const haystack = [item.account?.name, item.account?.email, item.subscriptionId, item.planName].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.subscriptionStatus && item.subscriptionStatus !== query.subscriptionStatus) return false;
        if (query.trialStatus && item.trialStatus !== query.trialStatus) return false;
        if (query.billingState && ((item.overdue ? 'overdue' : 'current') !== query.billingState)) return false;
        if (query.overdue === 'true' && !item.overdue) return false;
        if (query.overdue === 'false' && item.overdue) return false;
        if (query.plan && item.planName !== query.plan) return false;
        if (query.billingCycle && item.billingCycle !== query.billingCycle) return false;
        if (query.suspendedDueToBilling === 'true' && item.accountStatus !== 'suspended') return false;
        if (createdFrom && new Date(item.createdAt).getTime() < createdFrom.getTime()) return false;
        if (createdTo && new Date(item.createdAt).getTime() > createdTo.getTime()) return false;
        if (nextBillingFrom && item.nextBillingDate && new Date(item.nextBillingDate).getTime() < nextBillingFrom.getTime()) return false;
        if (nextBillingTo && item.nextBillingDate && new Date(item.nextBillingDate).getTime() > nextBillingTo.getTime()) return false;
        return true;
    });

    const sortBy = query.sortBy || 'createdAt';
    const direction = query.sortOrder === 'asc' ? 1 : -1;
    items = items.sort((a, b) => {
        const aValue = a[sortBy] || a.account?.[sortBy] || 0;
        const bValue = b[sortBy] || b.account?.[sortBy] || 0;
        if (aValue < bValue) return -1 * direction;
        if (aValue > bValue) return 1 * direction;
        return 0;
    });

    return paginate(items, query.page, query.limit);
}

async function getSubscriptionDetail(subscriptionId) {
    const bundle = await loadBillingDataset();
    const subscription = bundle.subscriptionsById.get(String(subscriptionId));
    if (!subscription) return null;
    const user = bundle.usersById.get(String(subscription.userId));
    if (!user) return null;
    return getAccountBillingOverview(String(user._id), String(subscription._id), bundle);
}

async function getAccountBundle(accountId, preloaded = null) {
    const bundle = preloaded || await loadBillingDataset();
    const user = bundle.usersById.get(String(accountId)) || await User.findById(accountId).lean();
    if (!user) return null;
    return {
        user,
        routers: bundle.routersByUser.get(String(accountId)) || [],
        subscriptions: bundle.subscriptionsByUser.get(String(accountId)) || [],
        transactions: bundle.transactionsByUser.get(String(accountId)) || [],
        auditLogs: bundle.auditLogs.filter((entry) => String(entry.targetUserId || '') === String(accountId)),
        subscriptionsByRouterId: bundle.subscriptionsByRouterId
    };
}

async function getAccountBillingOverview(accountId, focusSubscriptionId = null, preloaded = null) {
    const bundle = await getAccountBundle(accountId, preloaded);
    if (!bundle) return null;
    const { user, routers, subscriptions, transactions, auditLogs, subscriptionsByRouterId } = bundle;
    const summary = summarizeSubscription(subscriptions);
    const entitlements = buildEntitlements(user, routers, subscriptions);
    const invoices = transactions.filter((tx) => tx.type === 'invoice');
    const payments = transactions.filter((tx) => tx.type === 'payment');
    const focusedSubscription = focusSubscriptionId ? subscriptions.find((subscription) => String(subscription._id) === String(focusSubscriptionId)) : (subscriptions[0] || null);

    return {
        account: {
            id: String(user._id),
            name: user.name,
            email: user.email,
            accountStatus: user.isActive ? 'active' : 'suspended',
            currency: user.currency || 'USD',
            balance: user.balance || 0,
            billingReviewedAt: user.billingReviewedAt || null,
            billingReviewedBy: user.billingReviewedBy || null,
            billingSuspendedAt: user.billingSuspendedAt || null,
            billingSuspensionReason: user.billingSuspensionReason || null,
            billingReactivatedAt: user.billingReactivatedAt || null
        },
        subscription: focusedSubscription ? {
            id: String(focusedSubscription._id),
            status: focusedSubscription.status,
            planType: focusedSubscription.planType,
            pricePerMonth: focusedSubscription.pricePerMonth,
            currentPeriodStart: focusedSubscription.currentPeriodStart,
            currentPeriodEnd: focusedSubscription.currentPeriodEnd,
            trialEndsAt: focusedSubscription.trialEndsAt || null,
            nextBillingDate: focusedSubscription.nextBillingDate || null,
            lastPaymentDate: focusedSubscription.lastPaymentDate || null,
            paymentMethod: focusedSubscription.paymentMethod || null
        } : null,
        overview: {
            currentPlan: summary.planType || summary.status,
            subscriptionStatus: summary.status,
            trialStart: user.createdAt,
            trialEnd: user.trialEndsAt || null,
            billingCycle: summary.planType === 'trial' ? 'trial' : 'monthly',
            unitPricing: PRICING.ROUTER_MONTHLY_PRICE,
            billableRouters: summary.billableRouters,
            estimatedRecurringValue: summary.monthlyValue,
            nextBillingDate: summary.nextBillingDate,
            overdue: summary.overdueCount > 0,
            gracePeriodActive: isGracePeriodActive(user),
            gracePeriodEndsAt: user.billingGracePeriodEndsAt || null,
            openInvoices: invoices.filter((tx) => tx.status === 'pending').length,
            failedPayments: payments.filter((tx) => tx.status === 'failed').length
        },
        entitlements,
        routers: {
            total: routers.length,
            items: buildBillableRouterItems(routers, subscriptionsByRouterId)
        },
        invoices: invoices.slice(0, 10).map((tx) => normalizeTransaction(tx, user, bundle.subscriptions.find((sub) => String(sub._id) === String(tx.subscriptionId)) || null)),
        payments: payments.slice(0, 10).map((tx) => normalizeTransaction(tx, user, bundle.subscriptions.find((sub) => String(sub._id) === String(tx.subscriptionId)) || null)),
        recentEvents: auditLogs.slice(0, 10).map((entry) => ({
            id: String(entry._id),
            action: entry.action,
            actor: entry.actorUserId ? {
                id: String(entry.actorUserId._id),
                name: entry.actorUserId.name,
                email: entry.actorUserId.email
            } : null,
            reason: entry.reason || '',
            metadata: entry.metadata || {},
            createdAt: entry.createdAt
        })),
        notes: (user.adminNotes || []).map(normalizeNote).filter((note) => BILLING_NOTE_CATEGORIES.includes(note.category) || note.category === 'billing'),
        flags: (user.internalFlags || []).map(normalizeFlag).filter((flag) => BILLING_FLAG_TYPES.includes(flag.flag) || flag.flag === 'overdue_billing')
    };
}

async function getAccountEntitlements(accountId) {
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return null;
    return buildEntitlements(bundle.user, bundle.routers, bundle.subscriptions);
}

async function getAccountBillableRouters(accountId) {
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return null;
    const items = buildBillableRouterItems(bundle.routers, bundle.subscriptionsByRouterId);
    return {
        totalRouters: items.length,
        billableRouters: items.filter((item) => item.countedTowardBilling).length,
        freeOrTrialCoveredRouters: items.filter((item) => !item.countedTowardBilling && item.reason === 'Covered by trial').length,
        excludedRouters: items.filter((item) => !item.countedTowardBilling && item.reason !== 'Covered by trial').length,
        items
    };
}

function deriveBillingActivity(user, subscriptions, transactions, auditLogs) {
    const items = [];
    subscriptions.forEach((subscription) => {
        items.push({
            id: `subscription-${subscription._id}`,
            type: 'subscription_event',
            source: 'billing',
            summary: `Subscription ${subscription.status}`,
            timestamp: subscription.updatedAt || subscription.createdAt,
            metadata: {
                subscriptionId: String(subscription._id),
                planType: subscription.planType,
                pricePerMonth: subscription.pricePerMonth
            }
        });
    });
    transactions.forEach((transaction) => {
        items.push({
            id: `transaction-${transaction._id}`,
            type: transaction.status === 'failed' ? 'payment_failed' : `${transaction.type}_event`,
            source: transaction.type,
            summary: transaction.description,
            timestamp: transaction.settledAt || transaction.createdAt,
            metadata: normalizeTransaction(transaction, user, null)
        });
    });
    auditLogs.forEach((entry) => {
        items.push({
            id: `audit-${entry._id}`,
            type: entry.action,
            source: 'admin',
            summary: entry.reason || entry.action,
            timestamp: entry.createdAt,
            actor: entry.actorUserId ? {
                id: String(entry.actorUserId._id),
                name: entry.actorUserId.name,
                email: entry.actorUserId.email
            } : null,
            metadata: entry.metadata || {}
        });
    });
    return items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
}

async function getAccountBillingActivity(accountId, query = {}) {
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return null;
    let items = deriveBillingActivity(bundle.user, bundle.subscriptions, bundle.transactions, bundle.auditLogs);
    if (query.type) items = items.filter((item) => item.type === query.type);
    if (query.source) items = items.filter((item) => item.source === query.source);
    return paginate(items, query.page, query.limit);
}

async function getGlobalBillingActivity(query = {}) {
    const bundle = await loadBillingDataset();
    let items = [];
    for (const user of bundle.users) {
        const subscriptions = bundle.subscriptionsByUser.get(String(user._id)) || [];
        const transactions = bundle.transactionsByUser.get(String(user._id)) || [];
        const auditLogs = bundle.auditLogs.filter((entry) => String(entry.targetUserId || '') === String(user._id));
        items = items.concat(deriveBillingActivity(user, subscriptions, transactions, auditLogs).slice(0, 20));
    }
    if (query.type) items = items.filter((item) => item.type === query.type);
    if (query.source) items = items.filter((item) => item.source === query.source);
    items = items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return paginate(items, query.page, query.limit);
}

async function listInvoices(query = {}) {
    const bundle = await loadBillingDataset();
    const userIds = new Set(bundle.transactions.filter((tx) => tx.type === 'invoice').map((tx) => String(tx.userId)));
    let items = bundle.transactions
        .filter((tx) => tx.type === 'invoice')
        .map((tx) => normalizeTransaction(tx, bundle.usersById.get(String(tx.userId)) || null, bundle.subscriptionsById.get(String(tx.subscriptionId)) || null));

    const q = String(query.q || '').trim().toLowerCase();
    items = items.filter((item) => {
        if (q) {
            const haystack = [item.transactionId, item.description, item.account?.name, item.account?.email, item.subscription?.planType].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.status && item.status !== query.status) return false;
        return true;
    });
    return paginate(items, query.page, query.limit);
}

async function getInvoiceDetail(invoiceId) {
    const transaction = await Transaction.findOne({ _id: invoiceId, type: 'invoice' }).lean();
    if (!transaction) return null;
    const [user, subscription] = await Promise.all([
        User.findById(transaction.userId).lean(),
        transaction.subscriptionId ? Subscription.findById(transaction.subscriptionId).lean() : Promise.resolve(null)
    ]);
    return normalizeTransaction(transaction, user, subscription);
}

async function getAccountInvoices(accountId, query = {}) {
    const account = await getAccountBundle(accountId);
    if (!account) return null;
    const items = account.transactions.filter((tx) => tx.type === 'invoice').map((tx) => normalizeTransaction(tx, account.user, account.subscriptions.find((sub) => String(sub._id) === String(tx.subscriptionId)) || null));
    return paginate(items, query.page, query.limit);
}

async function listPayments(query = {}) {
    const bundle = await loadBillingDataset();
    let items = bundle.transactions
        .filter((tx) => tx.type === 'payment')
        .map((tx) => normalizeTransaction(tx, bundle.usersById.get(String(tx.userId)) || null, bundle.subscriptionsById.get(String(tx.subscriptionId)) || null));

    const q = String(query.q || '').trim().toLowerCase();
    items = items.filter((item) => {
        if (q) {
            const haystack = [item.transactionId, item.description, item.account?.name, item.account?.email, item.paymentMethod].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        if (query.status && item.status !== query.status) return false;
        if (query.paymentMethod && item.paymentMethod !== query.paymentMethod) return false;
        return true;
    });
    return paginate(items, query.page, query.limit);
}

async function getPaymentDetail(paymentId) {
    const transaction = await Transaction.findOne({ _id: paymentId, type: 'payment' }).lean();
    if (!transaction) return null;
    const user = await User.findById(transaction.userId).lean();
    return normalizeTransaction(transaction, user, null);
}

async function getAccountPayments(accountId, query = {}) {
    const account = await getAccountBundle(accountId);
    if (!account) return null;
    const items = account.transactions.filter((tx) => tx.type === 'payment').map((tx) => normalizeTransaction(tx, account.user, null));
    return paginate(items, query.page, query.limit);
}

async function getBillingRiskSummary() {
    const bundle = await loadBillingDataset();
    const overdueAccounts = bundle.users.filter((user) => (bundle.subscriptionsByUser.get(String(user._id)) || []).some((subscription) => subscription.status === 'past_due'));
    const trialsEndingSoon = bundle.users.filter((user) => isTrialEndingSoon(user.trialEndsAt));
    const gracePeriodAccounts = bundle.users.filter((user) => isGracePeriodActive(user));
    const suspendedAccounts = bundle.users.filter((user) => user.billingSuspendedAt && !user.isActive);
    return {
        overdueAccounts: overdueAccounts.length,
        overdueInvoices: bundle.transactions.filter((tx) => tx.type === 'invoice' && tx.status === 'pending').length,
        failedPayments: bundle.transactions.filter((tx) => tx.type === 'payment' && tx.status === 'failed').length,
        repeatedPaymentFailures: bundle.users.filter((user) => (bundle.transactionsByUser.get(String(user._id)) || []).filter((tx) => tx.type === 'payment' && tx.status === 'failed').length >= 2).length,
        trialsEndingSoon: trialsEndingSoon.length,
        gracePeriodAccounts: gracePeriodAccounts.length,
        accountsAtRiskOfSuspension: overdueAccounts.filter((user) => !isGracePeriodActive(user) && user.isActive).length,
        accountsSuspendedForBilling: suspendedAccounts.length,
        highValueOverdueAccounts: overdueAccounts.map((user) => {
            const summary = summarizeSubscription(bundle.subscriptionsByUser.get(String(user._id)) || []);
            return {
                accountId: String(user._id),
                name: user.name,
                email: user.email,
                estimatedRecurringValue: summary.monthlyValue
            };
        }).sort((a, b) => b.estimatedRecurringValue - a.estimatedRecurringValue).slice(0, 10)
    };
}

async function getBillingAnalytics(query = {}) {
    const bundle = await loadBillingDataset();
    const config = getWindowConfig(query.window);
    const buckets = createTrendBuckets(config);
    const start = Date.now() - config.ms;

    bundle.subscriptions.forEach((subscription) => {
        if (new Date(subscription.createdAt).getTime() >= start) {
            addToTrendBuckets(buckets, subscription.createdAt, 'subscriptionsCreated', config.bucketMs);
        }
        if (subscription.canceledAt && new Date(subscription.canceledAt).getTime() >= start) {
            addToTrendBuckets(buckets, subscription.canceledAt, 'cancellations', config.bucketMs);
        }
    });
    bundle.transactions.forEach((transaction) => {
        if (transaction.type === 'invoice' && transaction.status === 'completed') {
            addToTrendBuckets(buckets, transaction.settledAt || transaction.createdAt, 'invoicesCompleted', config.bucketMs);
        }
        if (transaction.type === 'payment' && transaction.status === 'completed') {
            addToTrendBuckets(buckets, transaction.settledAt || transaction.createdAt, 'paymentsCompleted', config.bucketMs);
        }
        if (transaction.type === 'payment' && transaction.status === 'failed') {
            addToTrendBuckets(buckets, transaction.createdAt, 'paymentFailures', config.bucketMs);
        }
    });

    return {
        window: config.key,
        summary: {
            activeMRREstimate: bundle.subscriptions.filter((subscription) => subscription.planType === 'monthly' && ['active', 'past_due'].includes(subscription.status)).reduce((sum, subscription) => sum + (subscription.pricePerMonth || 0), 0),
            completedInvoiceRevenue: bundle.transactions.filter((tx) => tx.type === 'invoice' && tx.status === 'completed').reduce((sum, tx) => sum + (tx.amount || 0), 0),
            completedPayments: bundle.transactions.filter((tx) => tx.type === 'payment' && tx.status === 'completed').reduce((sum, tx) => sum + (tx.amount || 0), 0),
            failedPayments: bundle.transactions.filter((tx) => tx.type === 'payment' && tx.status === 'failed').length
        },
        series: buckets
    };
}

async function listTrials(query = {}) {
    const bundle = await loadBillingDataset();
    const items = bundle.users
        .filter((user) => user.trialEndsAt && new Date(user.trialEndsAt) > new Date())
        .map((user) => {
            const summary = summarizeSubscription(bundle.subscriptionsByUser.get(String(user._id)) || []);
            return {
                accountId: String(user._id),
                name: user.name,
                email: user.email,
                trialEndsAt: user.trialEndsAt,
                trialEndingSoon: isTrialEndingSoon(user.trialEndsAt),
                subscriptionsOnTrial: (bundle.subscriptionsByUser.get(String(user._id)) || []).filter((subscription) => subscription.planType === 'trial').length,
                estimatedRecurringValue: summary.monthlyValue
            };
        })
        .sort((a, b) => new Date(a.trialEndsAt).getTime() - new Date(b.trialEndsAt).getTime());
    return paginate(items, query.page, query.limit);
}

async function getBillingNotes(accountId) {
    const user = await User.findById(accountId).select('adminNotes');
    if (!user) return null;
    return (user.adminNotes || []).map(normalizeNote).filter((note) => BILLING_NOTE_CATEGORIES.includes(note.category) || note.category === 'billing');
}

async function getBillingFlags(accountId) {
    const user = await User.findById(accountId).select('internalFlags');
    if (!user) return null;
    return (user.internalFlags || []).map(normalizeFlag).filter((flag) => BILLING_FLAG_TYPES.includes(flag.flag) || flag.flag === 'overdue_billing');
}

async function extendAccountTrial(accountId, days, authorEmail, reason = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    const base = user.trialEndsAt && new Date(user.trialEndsAt) > new Date() ? new Date(user.trialEndsAt) : new Date();
    base.setDate(base.getDate() + Number(days));
    user.trialEndsAt = base;
    user.adminNotes.push({
        body: `Extended billing trial by ${days} day(s). ${reason}`.trim(),
        category: 'billing',
        author: authorEmail
    });
    await user.save();

    const subscriptions = await Subscription.find({ userId: user._id, planType: 'trial', status: 'trial' });
    for (const subscription of subscriptions) {
        subscription.trialEndsAt = base;
        subscription.currentPeriodEnd = base;
        subscription.nextBillingDate = base;
        await subscription.save();
    }

    return user;
}

async function markBillingReviewed(accountId, reviewerEmail, note = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    user.billingReviewedAt = new Date();
    user.billingReviewedBy = reviewerEmail;
    if (note) {
        user.adminNotes.push({
            body: note,
            category: 'finance_review',
            author: reviewerEmail
        });
    }
    await user.save();
    return user;
}

async function suspendAccountForBilling(accountId, reviewerEmail, reason = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    user.isActive = false;
    user.billingSuspendedAt = new Date();
    user.billingSuspensionReason = reason || 'Suspended for billing review';
    user.adminNotes.push({
        body: `Account suspended for billing. ${reason}`.trim(),
        category: 'overdue',
        author: reviewerEmail
    });
    await user.save();
    return user;
}

async function reactivateAccountAfterBilling(accountId, reviewerEmail, reason = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    user.isActive = true;
    user.billingReactivatedAt = new Date();
    user.billingSuspensionReason = '';
    user.adminNotes.push({
        body: `Account reactivated after billing resolution. ${reason}`.trim(),
        category: 'billing',
        author: reviewerEmail
    });
    await user.save();
    return user;
}

async function resendLatestInvoice(accountId) {
    const user = await User.findById(accountId);
    if (!user) return null;
    const invoice = await Transaction.findOne({ userId: user._id, type: 'invoice' }).sort({ createdAt: -1 });
    if (!invoice) {
        const error = new Error('No invoice found for this account');
        error.code = 'INVOICE_NOT_FOUND';
        throw error;
    }
    await sendBillingReminderEmail(user, {
        amount: invoice.amount,
        dueDate: invoice.dueDate || invoice.createdAt,
        reference: invoice.transactionId,
        message: invoice.status === 'pending' ? 'A pending billing item is awaiting payment or balance top-up.' : 'Here is a copy of your recent billing reference.'
    });
    user.billingReminderSentAt = new Date();
    await user.save();
    return invoice;
}

async function applyGracePeriod(accountId, days, authorEmail, reason = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    const base = user.billingGracePeriodEndsAt && new Date(user.billingGracePeriodEndsAt) > new Date() ? new Date(user.billingGracePeriodEndsAt) : new Date();
    base.setDate(base.getDate() + Number(days));
    user.billingGracePeriodEndsAt = base;
    user.adminNotes.push({
        body: `Applied billing grace period until ${base.toISOString()}. ${reason}`.trim(),
        category: 'grace_period',
        author: authorEmail
    });
    await user.save();
    return user;
}

async function removeGracePeriod(accountId, authorEmail, reason = '') {
    const user = await User.findById(accountId);
    if (!user) return null;
    user.billingGracePeriodEndsAt = null;
    user.adminNotes.push({
        body: `Removed billing grace period. ${reason}`.trim(),
        category: 'grace_period',
        author: authorEmail
    });
    await user.save();
    return user;
}

module.exports = {
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
};
