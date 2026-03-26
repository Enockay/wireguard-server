const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const ServicePlan = require('../models/ServicePlan');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const { log } = require('../wg-core');
const {
    suspendSubscriptionOnRouter,
    reactivateSubscriptionOnRouter
} = require('./billing-service');
const {
    notifySubscriptionExpired,
    notifyPaymentConfirmed
} = require('./notification-service');

function createTransactionId(prefix = 'PAY') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function addDays(baseDate, days) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + Number(days || 30));
    return date;
}

async function checkAndEnforceSubscriptions() {
    const now = new Date();
    const subscriptions = await Subscription.find({
        status: { $in: ['active', 'trial'] }
    }).populate('userId', '_id name email currency');

    const report = {
        checked: subscriptions.length,
        suspended: 0,
        skipped: 0,
        errors: 0,
        items: []
    };

    for (const subscription of subscriptions) {
        try {
            const trialExpired = subscription.status === 'trial' && subscription.trialEndsAt && new Date(subscription.trialEndsAt) < now;
            const billingExpired = subscription.status === 'active' && subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) < now;

            if (!trialExpired && !billingExpired) {
                report.skipped += 1;
                report.items.push({
                    subscriptionId: String(subscription._id),
                    action: 'skipped'
                });
                continue;
            }

            const result = await enforceSubscriptionSuspension(subscription, {
                reason: trialExpired ? 'Trial period expired' : 'Billing period ended'
            });
            if (result?.skipped) {
                report.skipped += 1;
                report.items.push({
                    subscriptionId: String(subscription._id),
                    action: 'skipped',
                    reason: result.reason
                });
                continue;
            }
            report.suspended += 1;
            report.items.push({
                subscriptionId: String(subscription._id),
                action: 'suspended',
                result: {
                    id: String(result._id),
                    status: result.status
                }
            });
        } catch (error) {
            report.errors += 1;
            report.items.push({
                subscriptionId: String(subscription._id),
                action: 'error',
                error: error.message
            });
            log('error', 'billing_enforcement_subscription_failed', {
                subscriptionId: subscription._id,
                error: error.message
            });
        }
    }

    log('info', 'billing_enforcement_completed', report);
    return report;
}

async function enforceSubscriptionSuspension(subscription, options = {}) {
    const subscriptionId = subscription?._id || subscription;
    const now = new Date();
    const cutoff = new Date(now.getTime() - (6 * 60 * 60 * 1000));
    const hydratedSubscription = await Subscription.findOneAndUpdate(
        {
            _id: subscriptionId,
            status: { $in: ['active', 'trial'] },
            $or: [
                { enforcedAt: { $exists: false } },
                { enforcedAt: null },
                { enforcedAt: { $lte: cutoff } }
            ]
        },
        {
            $set: {
                status: 'suspended',
                enforcedAt: now
            }
        },
        {
            new: true
        }
    ).populate('userId', '_id name email currency');

    if (!hydratedSubscription) {
        const existingSubscription = await Subscription.findById(subscriptionId).select('_id status enforcedAt');
        if (existingSubscription?.status === 'suspended') {
            return { skipped: true, reason: 'already_suspended' };
        }
        if (existingSubscription?.enforcedAt && existingSubscription.enforcedAt > cutoff) {
            return { skipped: true, reason: 'recently_enforced' };
        }
        throw new Error('Subscription not found');
    }

    await suspendSubscriptionOnRouter(hydratedSubscription).catch((error) => {
        log('warn', 'billing_enforcement_router_suspend_failed', {
            subscriptionId: hydratedSubscription._id,
            error: error.message
        });
    });

    const user = hydratedSubscription.userId?._id
        ? hydratedSubscription.userId
        : await User.findById(hydratedSubscription.userId).select('_id name email currency');

    const router = await MikrotikRouter.findById(hydratedSubscription.routerId).select('_id name vpnIp');
    if (user && router) {
        await notifySubscriptionExpired(user, router).catch((error) => {
            log('warn', 'subscription_expired_notification_failed', {
                subscriptionId: hydratedSubscription._id,
                error: error.message
            });
        });
    }

    log('info', 'subscription_suspended_by_enforcement', {
        subscriptionId: hydratedSubscription._id,
        userId: user?._id || hydratedSubscription.userId,
        reason: options.reason || 'billing_expired'
    });

    return hydratedSubscription;
}

async function handlePaymentConfirmed(subscriptionId, amountPaid, paymentMethod, reference, options = {}) {
    const subscription = await Subscription.findById(subscriptionId).populate('userId', '_id name email currency');
    if (!subscription) {
        throw new Error('Subscription not found');
    }

    const servicePlan = subscription.servicePlanId
        ? await ServicePlan.findById(subscription.servicePlanId).select('_id name validityDays')
        : null;
    const validityDays = Math.max(1, Number(servicePlan?.validityDays || 30));
    const periodBase = subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) > new Date()
        ? new Date(subscription.currentPeriodEnd)
        : new Date();

    let transaction = null;
    if (options.transactionId) {
        transaction = await Transaction.findById(options.transactionId);
    }
    if (!transaction && reference) {
        transaction = await Transaction.findOne({
            $or: [
                { paymentGatewayId: reference },
                { transactionId: reference }
            ]
        }).sort({ createdAt: -1 });
    }

    if (!transaction) {
        transaction = await Transaction.create({
            userId: subscription.userId?._id || subscription.userId,
            type: 'payment',
            transactionId: createTransactionId('PAY'),
            amount: Number(amountPaid || subscription.pricePerMonth || 0),
            currency: subscription.userId?.currency || 'KES',
            description: `Subscription payment for ${servicePlan?.name || subscription.planType || 'service plan'}`,
            status: 'completed',
            paymentMethod: paymentMethod || 'manual',
            paymentGatewayId: reference || '',
            settledAt: new Date(),
            routerId: subscription.routerId,
            subscriptionId: subscription._id,
            metadata: {
                reference: reference || '',
                source: options.source || 'payment_confirmation'
            }
        });
    } else {
        transaction.status = 'completed';
        transaction.amount = Number(amountPaid || transaction.amount || 0);
        transaction.paymentMethod = paymentMethod || transaction.paymentMethod || 'manual';
        transaction.paymentGatewayId = reference || transaction.paymentGatewayId || '';
        transaction.subscriptionId = subscription._id;
        transaction.routerId = subscription.routerId;
        transaction.settledAt = new Date();
        transaction.failureReason = '';
        transaction.metadata = {
            ...(transaction.metadata || {}),
            reference: reference || transaction.paymentGatewayId || transaction.transactionId,
            source: options.source || 'payment_confirmation'
        };
        await transaction.save();
    }

    subscription.currentPeriodStart = new Date();
    subscription.currentPeriodEnd = addDays(periodBase, validityDays);
    subscription.nextBillingDate = new Date(subscription.currentPeriodEnd);
    subscription.lastPaymentDate = new Date();
    subscription.status = 'active';
    subscription.paymentMethod = paymentMethod || subscription.paymentMethod || 'manual';
    await subscription.save();

    await reactivateSubscriptionOnRouter(subscription).catch((error) => {
        log('warn', 'billing_enforcement_router_reactivate_failed', {
            subscriptionId: subscription._id,
            error: error.message
        });
    });

    const user = subscription.userId?._id
        ? subscription.userId
        : await User.findById(subscription.userId).select('_id name email currency');

    const router = await MikrotikRouter.findById(subscription.routerId).select('_id name vpnIp');
    if (user && router) {
        await notifyPaymentConfirmed(user, router, transaction.amount).catch((error) => {
            log('warn', 'payment_confirmation_notification_failed', {
                subscriptionId: subscription._id,
                error: error.message
            });
        });
    }

    log('info', 'subscription_payment_confirmed', {
        subscriptionId: subscription._id,
        transactionId: transaction._id,
        amount: transaction.amount,
        paymentMethod: transaction.paymentMethod,
        reference: reference || ''
    });

    return subscription;
}

module.exports = {
    checkAndEnforceSubscriptions,
    enforceSubscriptionSuspension,
    handlePaymentConfirmed
};
