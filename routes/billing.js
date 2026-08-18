const Subscription = require('../models/Subscription');
const MikrotikRouter = require('../models/MikrotikRouter');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');
const { getUserBillingSummary } = require('../services/billing-service');

function registerBillingRoutes(app) {
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

            // Create pending transaction
            const transaction = new Transaction({
                userId,
                type: 'payment',
                transactionId: `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                amount,
                description: `Balance added via ${paymentMethod === 'paystack' ? 'PayStack' : 'PayPal'}.`,
                status: 'pending',
                paymentMethod
            });

            await transaction.save();

            // Generate payment link based on method
            // In production, you would integrate with PayPal/Paystack APIs here
            const paymentLink = paymentMethod === 'paystack' 
                ? `/api/billing/paystack/initiate?transactionId=${transaction.transactionId}`
                : `/api/billing/paypal/initiate?transactionId=${transaction.transactionId}`;

            res.json({
                success: true,
                message: 'Payment initiated',
                transaction: {
                    id: transaction._id,
                    transactionId: transaction.transactionId,
                    amount: transaction.amount,
                    paymentLink
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

    // Complete payment (webhook callback)
    app.post('/api/billing/payment-callback', async (req, res) => {
        try {
            const { transactionId, status, paymentGatewayId, paymentMethod } = req.body;

            const transaction = await Transaction.findOne({ transactionId });

            if (!transaction) {
                return res.status(404).json({
                    success: false,
                    error: 'Transaction not found'
                });
            }

            if (transaction.status !== 'pending') {
                return res.status(400).json({
                    success: false,
                    error: 'Transaction already processed'
                });
            }

            if (status === 'completed') {
                // Add balance to user
                const user = await User.findById(transaction.userId);
                user.balance = (user.balance || 0) + transaction.amount;
                await user.save();

                transaction.status = 'completed';
                transaction.paymentGatewayId = paymentGatewayId;
                await transaction.save();

                log('info', 'balance_added', { 
                    userId: user._id, 
                    amount: transaction.amount,
                    transactionId: transaction.transactionId
                });
            } else {
                transaction.status = 'failed';
                await transaction.save();
            }

            res.json({
                success: true,
                message: 'Payment processed'
            });
        } catch (error) {
            log('error', 'payment_callback_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to process payment',
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
