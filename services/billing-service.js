const Subscription = require('../models/Subscription');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const Client = require('../models/Client');
const Settings = require('../models/Settings');
const { log, wgLock, runWgCommand, validateKeepalive, isValidWgKey, isValidCidr } = require('../wg-core');
const { sendInvoiceEmail } = require('./email-service');
const { startRouterProxy, stopRouterProxy } = require('./tcp-proxy-service');

const WG_ENABLED = !["0", "false", "no", "off"].includes(String(process.env.WG_ENABLED || "true").toLowerCase());

// Best-effort invoice email - a delivery failure must never roll back or
// block a completed charge, so this always resolves rather than throwing.
async function notifyInvoice(user, transaction) {
    try {
        await sendInvoiceEmail(user, transaction);
        log('info', 'invoice_email_sent', { userId: user._id, transactionId: transaction.transactionId });
    } catch (error) {
        log('error', 'invoice_email_failed', { userId: user._id, transactionId: transaction.transactionId, error: error.message });
    }
}

/**
 * Grants or revokes a router's actual VPN + public-port access, in sync with
 * its subscription status. This is the enforcement side of billing - without
 * it, past_due/expired subscriptions were only a label with no real effect:
 * the WireGuard peer stayed up and the Winbox/SSH/API proxy kept forwarding
 * regardless of payment status.
 *
 * Acts immediately (direct `wg set` + proxy start/stop) rather than waiting
 * on the periodic cleanupDisabledPeers/reconcilePeers jobs, so suspending or
 * renewing a router takes effect within seconds, not minutes.
 */
async function setRouterAccess(routerId, enabled) {
    try {
        const router = await MikrotikRouter.findById(routerId);
        if (!router || !router.wireguardClientId) return;

        const client = await Client.findById(router.wireguardClientId);
        if (!client) return;

        client.enabled = enabled;
        await client.save();

        if (WG_ENABLED && isValidWgKey(client.publicKey)) {
            if (enabled && isValidCidr(client.ip)) {
                const keepalive = validateKeepalive(client.persistentKeepalive);
                await wgLock.run(() => runWgCommand([
                    'set', 'wg0', 'peer', client.publicKey,
                    'allowed-ips', client.ip,
                    'persistent-keepalive', String(keepalive)
                ]));
            } else if (!enabled) {
                await wgLock.run(() => runWgCommand(['set', 'wg0', 'peer', client.publicKey, 'remove']));
            }
        }

        if (enabled) {
            await startRouterProxy(routerId);
        } else {
            stopRouterProxy(routerId);
        }

        log('info', enabled ? 'router_access_restored' : 'router_access_suspended', { routerId: routerId.toString() });
    } catch (error) {
        log('error', 'set_router_access_error', { routerId: routerId.toString(), enabled, error: error.message });
    }
}

// Pricing is admin-editable (see routes/admin-settings.js) and stored in the
// Settings singleton; these are only the fallback defaults used to seed it.
async function getPricing() {
    const settings = await Settings.getSingleton();
    return {
        ROUTER_MONTHLY_PRICE: settings.routerMonthlyPrice,
        TRIAL_DAYS: settings.trialDays
    };
}

/**
 * Check if this is user's first router (excluding the current router being created)
 */
async function isFirstRouter(userId, excludeRouterId = null) {
    const query = { userId };
    if (excludeRouterId) {
        query._id = { $ne: excludeRouterId };
    }
    const routerCount = await MikrotikRouter.countDocuments(query);
    return routerCount === 0;
}

/**
 * Create subscription for a router
 */
async function createSubscription(userId, routerId) {
    try {
        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const Transaction = require('../models/Transaction');
        const isFirst = await isFirstRouter(userId, routerId);
        const PRICING = await getPricing();

        // Calculate dates
        const now = new Date();
        let currentPeriodStart = now;
        let currentPeriodEnd = new Date();
        let trialEndsAt = null;
        let status = 'active';
        let planType = 'monthly';
        let amount = PRICING.ROUTER_MONTHLY_PRICE;

        if (isFirst) {
            // First router gets a free trial
            planType = 'trial';
            status = 'trial';
            trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + PRICING.TRIAL_DAYS);
            currentPeriodEnd = new Date(trialEndsAt);
            amount = 0; // Free trial
            user.trialUsed = true;
            await user.save();

            // Create transaction for trial
            const trialTransaction = new Transaction({
                userId,
                type: 'invoice',
                transactionId: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                amount: 0,
                description: `Payment for creating router ${routerId} with package Trial`,
                status: 'completed',
                paymentMethod: 'balance',
                routerId,
                metadata: { planType: 'trial' }
            });
            await trialTransaction.save();
        } else {
            // Check user balance
            const userBalance = user.balance || 0;
            if (userBalance < PRICING.ROUTER_MONTHLY_PRICE) {
                throw new Error(`Insufficient balance. Required: $${PRICING.ROUTER_MONTHLY_PRICE}, Available: $${userBalance}`);
            }

            // Deduct from balance
            user.balance = userBalance - PRICING.ROUTER_MONTHLY_PRICE;
            await user.save();

            // Regular monthly subscription
            currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);

            // Create transaction for payment
            const paymentTransaction = new Transaction({
                userId,
                type: 'invoice',
                transactionId: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                amount: PRICING.ROUTER_MONTHLY_PRICE,
                description: `Payment for creating router ${routerId} with package Standard`,
                status: 'completed',
                paymentMethod: 'balance',
                routerId,
                metadata: { planType: 'monthly' }
            });
            await paymentTransaction.save();

            log('info', 'balance_deducted', {
                userId,
                amount: PRICING.ROUTER_MONTHLY_PRICE,
                remainingBalance: user.balance
            });

            notifyInvoice(user, paymentTransaction);
        }

        const subscription = new Subscription({
            userId,
            routerId,
            status,
            planType,
            pricePerMonth: PRICING.ROUTER_MONTHLY_PRICE,
            currentPeriodStart,
            currentPeriodEnd,
            trialEndsAt,
            nextBillingDate: currentPeriodEnd
        });

        await subscription.save();

        log('info', 'subscription_created', {
            userId,
            routerId,
            planType,
            status,
            pricePerMonth: PRICING.ROUTER_MONTHLY_PRICE,
            isFirst
        });

        return subscription;
    } catch (error) {
        log('error', 'create_subscription_error', { userId, routerId, error: error.message });
        throw error;
    }
}

/**
 * Process monthly billing for a subscription.
 *
 * Charges from the user's existing balance (the same mechanism createSubscription
 * uses for the first period) rather than a payment gateway - this app has no
 * auto-charge-on-file integration, only manual wallet top-ups via PayPal/PayStack,
 * so balance is the only thing that can actually be billed automatically.
 *
 * Bug fixed here: this used to branch on subscription.isTrial(), which requires
 * `now < trialEndsAt`. But nextBillingDate is set equal to trialEndsAt at creation,
 * and the guard above it already requires `now >= nextBillingDate` - so isTrial()
 * could never be true at this point. Every due trial fell through to the "just
 * extend the period" branch below, which (per its own TODO) never charged anyone
 * either - trials silently renewed for free forever and never became `monthly`.
 * Branching on `planType === 'trial'` instead is correct: by the time we're here,
 * time-eligibility is already established by the nextBillingDate check.
 */
async function processBilling(subscriptionId) {
    try {
        const subscription = await Subscription.findById(subscriptionId)
            .populate('userId')
            .populate('routerId');

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        // Skip if already processed or canceled
        if (subscription.status === 'canceled' || subscription.status === 'expired') {
            return { skipped: true, reason: 'Subscription canceled or expired' };
        }

        // Check if billing is due
        if (new Date() < subscription.nextBillingDate) {
            return { skipped: true, reason: 'Billing not due yet' };
        }

        const user = subscription.userId;
        if (!user) {
            throw new Error('Subscription has no associated user (account may have been deleted)');
        }

        const isTrialConversion = subscription.planType === 'trial';
        const amount = subscription.pricePerMonth;
        const userBalance = user.balance || 0;

        if (userBalance < amount) {
            subscription.status = 'past_due';
            await subscription.save();
            log('warn', 'billing_insufficient_balance', {
                subscriptionId, userId: user._id, required: amount, available: userBalance
            });

            await setRouterAccess(subscription.routerId?._id || subscription.routerId, false);

            return {
                processed: false,
                type: 'past_due',
                reason: 'Insufficient balance',
                required: amount,
                available: userBalance
            };
        }

        const Transaction = require('../models/Transaction');

        user.balance = userBalance - amount;
        await user.save();

        const routerName = subscription.routerId?.name || subscription.routerId;
        const transaction = new Transaction({
            userId: user._id,
            type: 'invoice',
            transactionId: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            amount,
            description: isTrialConversion
                ? `First billing for router ${routerName} after trial`
                : `Monthly renewal for router ${routerName}`,
            status: 'completed',
            paymentMethod: 'balance',
            routerId: subscription.routerId?._id || subscription.routerId,
            subscriptionId: subscription._id,
            metadata: { planType: 'monthly', renewal: !isTrialConversion }
        });
        await transaction.save();

        subscription.planType = 'monthly';
        subscription.status = 'active';
        subscription.currentPeriodStart = new Date();
        subscription.currentPeriodEnd = new Date();
        subscription.currentPeriodEnd.setMonth(subscription.currentPeriodEnd.getMonth() + 1);
        subscription.nextBillingDate = new Date(subscription.currentPeriodEnd);
        subscription.lastPaymentDate = new Date();

        await subscription.save();

        log('info', isTrialConversion ? 'trial_to_paid' : 'billing_processed', {
            subscriptionId,
            userId: user._id,
            amount
        });

        notifyInvoice(user, transaction);

        // Idempotent if the router was never suspended - re-enabling an
        // already-enabled client and starting an already-running proxy are
        // both no-ops. Covers both the manual "Renew" button and a past_due
        // subscription getting picked up by the next automatic billing run
        // after the customer tops up their balance.
        await setRouterAccess(subscription.routerId?._id || subscription.routerId, true);

        return {
            processed: true,
            type: isTrialConversion ? 'trial_to_paid' : 'monthly',
            amount,
            nextBillingDate: subscription.nextBillingDate
        };
    } catch (error) {
        log('error', 'process_billing_error', { subscriptionId, error: error.message });
        throw error;
    }
}

/**
 * Process all due subscriptions
 */
async function processAllDueSubscriptions() {
    try {
        const now = new Date();
        const dueSubscriptions = await Subscription.find({
            $or: [
                { nextBillingDate: { $lte: now } },
                { trialEndsAt: { $lte: now }, planType: 'trial' }
            ],
            status: { $in: ['trial', 'active', 'past_due'] }
        });

        log('info', 'processing_due_subscriptions', { count: dueSubscriptions.length });

        const results = [];
        for (const subscription of dueSubscriptions) {
            try {
                const result = await processBilling(subscription._id);
                results.push({ subscriptionId: subscription._id, ...result });
            } catch (error) {
                log('error', 'subscription_billing_failed', {
                    subscriptionId: subscription._id,
                    error: error.message
                });
                results.push({
                    subscriptionId: subscription._id,
                    error: error.message
                });
            }
        }

        return results;
    } catch (error) {
        log('error', 'process_all_billing_error', { error: error.message });
        throw error;
    }
}

/**
 * Cancel subscription
 */
async function cancelSubscription(subscriptionId, userId) {
    try {
        const subscription = await Subscription.findOne({
            _id: subscriptionId,
            userId
        });

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        subscription.status = 'canceled';
        subscription.canceledAt = new Date();
        await subscription.save();

        log('info', 'subscription_canceled', { subscriptionId, userId });

        await setRouterAccess(subscription.routerId, false);

        return subscription;
    } catch (error) {
        log('error', 'cancel_subscription_error', { subscriptionId, userId, error: error.message });
        throw error;
    }
}

/**
 * Get user's billing summary
 */
async function getUserBillingSummary(userId) {
    try {
        const subscriptions = await Subscription.find({ userId })
            .populate('routerId')
            .sort({ createdAt: -1 });

        const activeSubscriptions = subscriptions.filter(s => s.isActive());
        const totalMonthlyCost = activeSubscriptions.reduce((sum, s) => {
            if (s.planType === 'monthly') {
                return sum + s.pricePerMonth;
            }
            return sum;
        }, 0);

        // Check if this is the first router (no routers exist yet)
        const isFirst = await isFirstRouter(userId);

        return {
            totalRouters: subscriptions.length,
            activeRouters: activeSubscriptions.length,
            totalMonthlyCost,
            isFirstRouter: isFirst,
            subscriptions: subscriptions.map(s => ({
                id: s._id,
                routerName: s.routerId?.name,
                status: s.status,
                planType: s.planType,
                pricePerMonth: s.pricePerMonth,
                currentPeriodEnd: s.currentPeriodEnd,
                nextBillingDate: s.nextBillingDate,
                trialEndsAt: s.trialEndsAt,
                isActive: s.isActive()
            }))
        };
    } catch (error) {
        log('error', 'get_billing_summary_error', { userId, error: error.message });
        throw error;
    }
}

module.exports = {
    createSubscription,
    processBilling,
    processAllDueSubscriptions,
    cancelSubscription,
    getUserBillingSummary,
    getPricing,
    setRouterAccess
};
