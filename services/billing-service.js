const Subscription = require('../models/Subscription');
const User = require('../models/User');
const MikrotikRouter = require('../models/MikrotikRouter');
const { log } = require('../wg-core');

// Pricing configuration (per router per month)
const PRICING = {
    ROUTER_MONTHLY_PRICE: parseFloat(process.env.ROUTER_MONTHLY_PRICE || '10.00'), // $10/month per router
    TRIAL_DAYS: 7 // 1 week free trial
};

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

        // Calculate dates
        const now = new Date();
        let currentPeriodStart = now;
        let currentPeriodEnd = new Date();
        let trialEndsAt = null;
        let status = 'active';
        let planType = 'monthly';
        let amount = PRICING.ROUTER_MONTHLY_PRICE;

        if (isFirst) {
            // First router gets 1 week free trial
            planType = 'trial';
            status = 'trial';
            trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + PRICING.TRIAL_DAYS); // 1 week
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
 * Process monthly billing for a subscription
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

        // If in trial, transition to paid
        if (subscription.isTrial()) {
            subscription.planType = 'monthly';
            subscription.status = 'active';
            subscription.currentPeriodStart = new Date();
            subscription.currentPeriodEnd = new Date();
            subscription.currentPeriodEnd.setMonth(subscription.currentPeriodEnd.getMonth() + 1);
            subscription.nextBillingDate = new Date(subscription.currentPeriodEnd);
            subscription.lastPaymentDate = new Date();

            await subscription.save();

            log('info', 'trial_to_paid', {
                subscriptionId,
                userId: subscription.userId._id
            });

            return { processed: true, type: 'trial_to_paid' };
        }

        // Process monthly payment
        // TODO: Integrate with payment gateway (Stripe, PayPal, etc.)
        // For now, we'll just update the billing cycle

        subscription.currentPeriodStart = new Date();
        subscription.currentPeriodEnd = new Date();
        subscription.currentPeriodEnd.setMonth(subscription.currentPeriodEnd.getMonth() + 1);
        subscription.nextBillingDate = new Date(subscription.currentPeriodEnd);
        subscription.lastPaymentDate = new Date();
        subscription.status = 'active';

        await subscription.save();

        log('info', 'billing_processed', {
            subscriptionId,
            userId: subscription.userId._id,
            amount: subscription.pricePerMonth
        });

        return {
            processed: true,
            type: 'monthly',
            amount: subscription.pricePerMonth,
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
            status: { $in: ['trial', 'active'] }
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
    PRICING
};
