const Subscription = require('../models/Subscription');
const MikrotikRouter = require('../models/MikrotikRouter');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');
const { getUserBillingSummary } = require('../services/billing-service');
const paystackService = require('../services/paystack-service');

function getFrontendUrl() {
    return process.env.FRONTEND_URL || process.env.SERVICE_URL_WIREGUARD || process.env.SERVICE_FQDN_WIREGUARD || 'https://vpn.blackie-networks.com';
}

/**
 * Applies a PayStack payment to the user's balance, idempotently. Called from
 * both the webhook (server-to-server, primary path) and the user-facing verify
 * endpoint (fallback for when the browser gets back before the webhook lands).
 * Whichever fires first wins - the other is a no-op since status is already
 * 'completed' by then.
 */
async function applyPaystackPayment(reference) {
    const transaction = await Transaction.findOne({ transactionId: reference });
    if (!transaction) {
        throw new Error('Transaction not found');
    }
    if (transaction.status === 'completed') {
        return { alreadyProcessed: true, transaction };
    }

    const verified = await paystackService.verifyTransaction(reference);

    if (verified.status !== 'success') {
        transaction.status = verified.status === 'abandoned' ? 'pending' : 'failed';
        await transaction.save();
        return { success: false, transaction, paystackStatus: verified.status };
    }

    // Defense in depth: don't trust the webhook/verify payload amount blindly -
    // confirm it matches what we asked the customer to pay.
    const verifiedAmountUsd = verified.amount / 100;
    if (Math.abs(verifiedAmountUsd - transaction.amount) > 0.01) {
        log('error', 'paystack_amount_mismatch', {
            reference, expected: transaction.amount, received: verifiedAmountUsd
        });
        transaction.status = 'failed';
        await transaction.save();
        return { success: false, transaction, error: 'Amount mismatch' };
    }

    const user = await User.findById(transaction.userId);
    if (!user) {
        throw new Error('Transaction has no associated user');
    }

    user.balance = (user.balance || 0) + transaction.amount;
    await user.save();

    transaction.status = 'completed';
    transaction.paymentGatewayId = String(verified.id || verified.reference);
    await transaction.save();

    log('info', 'paystack_payment_applied', { reference, userId: user._id, amount: transaction.amount });

    return { success: true, transaction, newBalance: user.balance };
}

function registerBillingRoutes(app) {
    // Current plan pricing/trial length - unauthenticated (same numbers already
    // shown on the public marketing site) so the dashboard's Pricing page can
    // display the real admin-configured value instead of a hardcoded one.
    app.get('/api/settings/pricing', async (req, res) => {
        try {
            const settings = await Settings.getSingleton();
            res.json({
                success: true,
                routerMonthlyPrice: settings.routerMonthlyPrice,
                trialDays: settings.trialDays
            });
        } catch (error) {
            log('error', 'get_pricing_settings_error', { error: error.message });
            res.status(500).json({ success: false, error: 'Failed to get pricing' });
        }
    });

    // Get billing summary
    app.get('/api/billing/summary', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const user = await User.findById(userId);
            const summary = await getUserBillingSummary(userId);

            // Calculate last month payments and invoices
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);

            const lastMonthPayments = await Transaction.aggregate([
                {
                    $match: {
                        userId: userId,
                        type: 'payment',
                        status: 'completed',
                        createdAt: { $gte: lastMonth }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' }
                    }
                }
            ]);

            const lastMonthInvoices = await Transaction.aggregate([
                {
                    $match: {
                        userId: userId,
                        type: 'invoice',
                        status: 'completed',
                        createdAt: { $gte: lastMonth }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' }
                    }
                }
            ]);

            res.json({
                success: true,
                summary: {
                    ...summary,
                    balance: user.balance || 0,
                    userBalance: user.balance || 0,
                    currency: user.currency || 'USD',
                    lastMonthPayments: lastMonthPayments[0]?.total || 0,
                    lastMonthInvoices: lastMonthInvoices[0]?.total || 0
                },
                billing: {
                    ...summary,
                    balance: user.balance || 0,
                    userBalance: user.balance || 0,
                    currency: user.currency || 'USD',
                    lastMonthPayments: lastMonthPayments[0]?.total || 0,
                    lastMonthInvoices: lastMonthInvoices[0]?.total || 0
                }
            });
        } catch (error) {
            log('error', 'get_billing_summary_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get billing summary',
                details: error.message
            });
        }
    });

    // Get billing history/transactions
    app.get('/api/billing/transactions', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { page = 1, limit = 20, type, months = 3 } = req.query;

            const query = { userId };
            if (type && type !== 'all') {
                query.type = type;
            }

            // Filter by months
            if (months) {
                const dateFilter = new Date();
                dateFilter.setMonth(dateFilter.getMonth() - parseInt(months));
                query.createdAt = { $gte: dateFilter };
            }

            const transactions = await Transaction.find(query)
                .populate('routerId', 'name')
                .sort({ createdAt: -1 })
                .limit(parseInt(limit))
                .skip((parseInt(page) - 1) * parseInt(limit));

            const total = await Transaction.countDocuments(query);

            res.json({
                success: true,
                transactions: transactions.map(tx => ({
                    id: tx._id,
                    type: tx.type,
                    transactionId: tx.transactionId,
                    date: tx.createdAt,
                    amount: tx.amount,
                    currency: tx.currency,
                    description: tx.description,
                    status: tx.status,
                    paymentMethod: tx.paymentMethod,
                    routerName: tx.routerId?.name
                })),
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'get_transactions_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get transactions',
                details: error.message
            });
        }
    });

    // Add balance (initiate payment)
    app.post('/api/billing/add-balance', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { amount, paymentMethod = 'paystack' } = req.body;

            if (!amount || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid amount'
                });
            }

            if (!['paypal', 'paystack'].includes(paymentMethod)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid payment method'
                });
            }

            if (paymentMethod === 'paypal') {
                return res.status(501).json({
                    success: false,
                    error: 'PayPal is not available yet. Please use PayStack.'
                });
            }

            if (!paystackService.isConfigured()) {
                return res.status(503).json({
                    success: false,
                    error: 'Payments are not configured yet. Please contact support.'
                });
            }

            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            // Each submission used to create a brand-new pending transaction
            // with no cleanup, so retrying (or hitting back after landing on
            // PayStack) piled up abandoned 'pending' rows that never resolve.
            // Superseding any of this user's still-open attempts for the same
            // method here keeps at most one truly-pending transaction per user
            // at a time, without touching ones from other payment methods or
            // ones already completed/failed.
            await Transaction.updateMany(
                { userId, type: 'payment', paymentMethod, status: 'pending' },
                { $set: { status: 'failed', description: 'Balance added via PayStack (superseded by a newer attempt)' } }
            );

            // Create pending transaction
            const transaction = new Transaction({
                userId,
                type: 'payment',
                transactionId: `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                amount,
                description: 'Balance added via PayStack',
                status: 'pending',
                paymentMethod
            });

            await transaction.save();

            const paystackData = await paystackService.initializeTransaction({
                email: user.email,
                amountUsd: amount,
                reference: transaction.transactionId,
                callbackUrl: `${getFrontendUrl()}/billing/callback`,
                metadata: { userId: String(userId), transactionId: transaction.transactionId }
            });

            res.json({
                success: true,
                message: 'Payment initiated',
                transaction: {
                    id: transaction._id,
                    transactionId: transaction.transactionId,
                    amount: transaction.amount,
                    paymentLink: paystackData.authorization_url
                }
            });
        } catch (error) {
            log('error', 'add_balance_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to initiate payment',
                details: error.message
            });
        }
    });

    // PayStack webhook (server-to-server, not user-authenticated - verified via signature)
    app.post('/api/billing/paystack/webhook', async (req, res) => {
        try {
            const signature = req.headers['x-paystack-signature'];
            const valid = paystackService.verifyWebhookSignature(req.rawBody, signature);

            if (!valid) {
                log('warn', 'paystack_webhook_invalid_signature');
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }

            const { event, data } = req.body;

            if (event === 'charge.success' && data?.reference) {
                await applyPaystackPayment(data.reference);
            }

            // PayStack just needs a 200 to stop retrying
            res.status(200).json({ received: true });
        } catch (error) {
            log('error', 'paystack_webhook_error', { error: error.message });
            // Still 200 - a 4xx/5xx here just makes PayStack retry a webhook
            // whose underlying cause (e.g. bad data) won't fix itself on retry.
            res.status(200).json({ received: true, error: error.message });
        }
    });

    // User-facing fallback: verify + apply a payment when the browser lands
    // back on the callback page, in case the webhook hasn't arrived yet.
    app.get('/api/billing/verify/:reference', authenticateToken, async (req, res) => {
        try {
            const { reference } = req.params;
            const transaction = await Transaction.findOne({ transactionId: reference });

            if (!transaction) {
                return res.status(404).json({ success: false, error: 'Transaction not found' });
            }
            if (String(transaction.userId) !== req.user.userId) {
                return res.status(403).json({ success: false, error: 'Not your transaction' });
            }

            const result = await applyPaystackPayment(reference);

            res.json({
                success: true,
                status: result.transaction.status,
                amount: result.transaction.amount,
                newBalance: result.newBalance
            });
        } catch (error) {
            log('error', 'verify_payment_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to verify payment',
                details: error.message
            });
        }
    });

    // Get subscription details for a router
    app.get('/api/billing/subscription/:routerId', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { routerId } = req.params;

            // Verify router belongs to user
            const router = await MikrotikRouter.findOne({ _id: routerId, userId });
            if (!router) {
                return res.status(404).json({
                    success: false,
                    error: 'Router not found'
                });
            }

            const subscription = await Subscription.findOne({ routerId })
                .populate('routerId', 'name');

            if (!subscription) {
                return res.status(404).json({
                    success: false,
                    error: 'Subscription not found'
                });
            }

            res.json({
                success: true,
                subscription: {
                    id: subscription._id,
                    routerName: subscription.routerId?.name,
                    status: subscription.status,
                    planType: subscription.planType,
                    pricePerMonth: subscription.pricePerMonth,
                    currentPeriodStart: subscription.currentPeriodStart,
                    currentPeriodEnd: subscription.currentPeriodEnd,
                    trialEndsAt: subscription.trialEndsAt,
                    nextBillingDate: subscription.nextBillingDate,
                    lastPaymentDate: subscription.lastPaymentDate,
                    paymentMethod: subscription.paymentMethod,
                    isActive: subscription.isActive(),
                    isTrial: subscription.isTrial(),
                    createdAt: subscription.createdAt
                }
            });
        } catch (error) {
            log('error', 'get_subscription_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get subscription',
                details: error.message
            });
        }
    });
}

module.exports = registerBillingRoutes;
