const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const { authenticateToken } = require('./auth');
const { initiateStk, queryStk, formatPhoneNumber } = require('../services/mpesa-service');
const { handlePaymentConfirmed } = require('../services/billing-enforcement-service');
const { log } = require('../wg-core');
const { verifyJsonWebhookSignature } = require('../utils/runtime-security');

function createTransactionId(prefix = 'MPESA') {
    return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

async function findAccessibleSubscription(subscriptionId, user) {
    const query = { _id: subscriptionId };
    if (user.role !== 'admin') {
        query.userId = user.userId;
    }
    return Subscription.findOne(query);
}

function registerPaymentRoutes(app) {
    app.post('/api/payments/mpesa/initiate', authenticateToken, async (req, res) => {
        try {
            const { subscriptionId, phoneNumber, amount } = req.body || {};
            if (!subscriptionId || !phoneNumber || !Number(amount || 0)) {
                return res.status(400).json({ success: false, error: 'subscriptionId, phoneNumber, and amount are required' });
            }

            const subscription = await findAccessibleSubscription(subscriptionId, req.user);
            if (!subscription) {
                return res.status(404).json({ success: false, error: 'Subscription not found' });
            }

            const formattedPhone = formatPhoneNumber(phoneNumber);
            const stk = await initiateStk(
                formattedPhone,
                amount,
                String(subscription._id),
                `Subscription ${subscription._id}`
            );

            const transaction = await Transaction.create({
                userId: subscription.userId,
                type: 'payment',
                transactionId: createTransactionId(),
                amount: Number(amount),
                currency: 'KES',
                description: `M-Pesa payment initiation for subscription ${subscription._id}`,
                status: 'pending',
                paymentMethod: 'mpesa',
                paymentGatewayId: stk.CheckoutRequestID,
                routerId: subscription.routerId,
                subscriptionId: subscription._id,
                metadata: {
                    phoneNumber: formattedPhone,
                    checkoutRequestId: stk.CheckoutRequestID,
                    initiatedBy: req.user.email
                }
            });

            return res.json({
                success: true,
                checkoutRequestId: stk.CheckoutRequestID,
                responseCode: stk.ResponseCode,
                responseDescription: stk.ResponseDescription,
                transactionId: String(transaction._id)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to initiate M-Pesa payment', details: error.message });
        }
    });

    app.post('/api/payments/mpesa/callback', async (req, res) => {
        try {
            const verification = verifyJsonWebhookSignature(req, process.env.MPESA_CALLBACK_SECRET, [
                'x-mpesa-signature',
                'x-webhook-signature'
            ]);
            if (!verification.ok) {
                if (verification.code === 'missing_secret') {
                    return res.status(503).json({ ResultCode: 1, ResultDesc: 'M-Pesa callback is not configured' });
                }
                return res.status(401).json({ ResultCode: 1, ResultDesc: 'Invalid callback signature' });
            }

            const callback = req.body?.Body?.stkCallback || {};
            const checkoutRequestId = callback.CheckoutRequestID;
            const resultCode = Number(callback.ResultCode);
            const resultDesc = callback.ResultDesc || 'Unknown callback result';
            const metadataItems = Array.isArray(callback.CallbackMetadata?.Item) ? callback.CallbackMetadata.Item : [];
            const metadata = metadataItems.reduce((acc, item) => {
                if (item?.Name) {
                    acc[item.Name] = item.Value;
                }
                return acc;
            }, {});

            const transaction = await Transaction.findOne({ paymentGatewayId: checkoutRequestId }).sort({ createdAt: -1 });
            if (!transaction) {
                return res.status(404).json({ ResultCode: 1, ResultDesc: 'Transaction not found' });
            }

            transaction.metadata = {
                ...(transaction.metadata || {}),
                callback,
                callbackMetadata: metadata
            };

            if (resultCode === 0 && transaction.status !== 'completed') {
                transaction.status = 'completed';
                transaction.settledAt = new Date();
                await transaction.save();
                await handlePaymentConfirmed(
                    transaction.subscriptionId,
                    metadata.Amount || transaction.amount,
                    'mpesa',
                    metadata.MpesaReceiptNumber || checkoutRequestId,
                    { source: 'mpesa_callback', transactionId: transaction._id }
                );
            } else if (resultCode !== 0) {
                transaction.status = 'failed';
                transaction.failureReason = resultDesc;
                await transaction.save();
            } else {
                await transaction.save();
            }

            return res.json({ ResultCode: 0, ResultDesc: 'Success' });
        } catch (error) {
            log('error', 'mpesa_callback_failed', { error: error.message });
            return res.status(500).json({ ResultCode: 1, ResultDesc: error.message });
        }
    });

    app.post('/api/payments/mpesa/query', authenticateToken, async (req, res) => {
        try {
            const { checkoutRequestId } = req.body || {};
            if (!checkoutRequestId) {
                return res.status(400).json({ success: false, error: 'checkoutRequestId is required' });
            }

            const transaction = await Transaction.findOne({ paymentGatewayId: checkoutRequestId }).sort({ createdAt: -1 });
            if (!transaction) {
                return res.status(404).json({ success: false, error: 'Transaction not found' });
            }
            if (req.user.role !== 'admin' && String(transaction.userId) !== String(req.user.userId)) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }

            const result = await queryStk(checkoutRequestId);
            if (Number(result.ResultCode) === 0 && transaction.status !== 'completed') {
                transaction.status = 'completed';
                transaction.settledAt = new Date();
                transaction.metadata = {
                    ...(transaction.metadata || {}),
                    queryResult: result
                };
                await transaction.save();
                await handlePaymentConfirmed(
                    transaction.subscriptionId,
                    transaction.amount,
                    'mpesa',
                    checkoutRequestId,
                    { source: 'mpesa_query', transactionId: transaction._id }
                );
            } else if (Number(result.ResultCode) && transaction.status === 'pending') {
                transaction.metadata = {
                    ...(transaction.metadata || {}),
                    queryResult: result
                };
                await transaction.save();
            }

            return res.json({
                success: true,
                status: transaction.status,
                result
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to query M-Pesa payment', details: error.message });
        }
    });
}

module.exports = registerPaymentRoutes;
