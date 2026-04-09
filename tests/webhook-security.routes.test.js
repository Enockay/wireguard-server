const test = require('node:test');
const assert = require('node:assert/strict');
const { withRouteApp } = require('./helpers/test-kit');
const { signJsonPayload } = require('../utils/runtime-security');

test('billing payment callback requires a verified webhook signature', async () => {
    const previousSecret = process.env.PAYMENT_CALLBACK_SECRET;
    process.env.PAYMENT_CALLBACK_SECRET = 'billing-secret';

    try {
        await withRouteApp({
            routeModulePath: 'routes/billing.js',
            mocks: {
                'models/Subscription.js': {},
                'models/MikrotikRouter.js': {},
                'models/Transaction.js': {
                    async findOne() {
                        throw new Error('should not reach transaction lookup without a valid signature');
                    }
                },
                'models/User.js': {},
                'wg-core.js': { log() {} },
                'routes/auth.js': { authenticateToken: (_req, _res, next) => next() },
                'services/billing-service.js': { getUserBillingSummary: async () => ({}) }
            }
        }, async ({ request }) => {
            const unsigned = await request('POST', '/api/billing/payment-callback', {
                body: { transactionId: 'PAY-1', status: 'completed' }
            });
            assert.equal(unsigned.response.status, 401);
            assert.equal(unsigned.json.error, 'Invalid payment webhook signature');

            const signed = await request('POST', '/api/billing/payment-callback', {
                body: { transactionId: 'PAY-1', status: 'completed' },
                headers: {
                    'x-webhook-signature': signJsonPayload({ transactionId: 'PAY-1', status: 'completed' }, process.env.PAYMENT_CALLBACK_SECRET)
                }
            });
            assert.equal(signed.response.status, 500);
            assert.match(signed.json.error, /Failed to process payment/i);
        });
    } finally {
        if (previousSecret === undefined) {
            delete process.env.PAYMENT_CALLBACK_SECRET;
        } else {
            process.env.PAYMENT_CALLBACK_SECRET = previousSecret;
        }
    }
});

test('mpesa callback requires a verified webhook signature', async () => {
    const previousSecret = process.env.MPESA_CALLBACK_SECRET;
    process.env.MPESA_CALLBACK_SECRET = 'mpesa-secret';

    try {
        await withRouteApp({
            routeModulePath: 'routes/payments.js',
            mocks: {
                'models/Subscription.js': {},
                'models/Transaction.js': {
                    findOne() {
                        return {
                            sort: async () => {
                                throw new Error('should not reach transaction lookup without a valid signature');
                            }
                        };
                    }
                },
                'routes/auth.js': { authenticateToken: (_req, _res, next) => next() },
                'services/mpesa-service.js': {
                    initiateStk: async () => ({}),
                    queryStk: async () => ({}),
                    formatPhoneNumber: (value) => value
                },
                'services/billing-enforcement-service.js': { handlePaymentConfirmed: async () => ({}) },
                'wg-core.js': { log() {} }
            }
        }, async ({ request }) => {
            const body = {
                Body: {
                    stkCallback: {
                        CheckoutRequestID: 'checkout-1',
                        ResultCode: 0
                    }
                }
            };

            const unsigned = await request('POST', '/api/payments/mpesa/callback', { body });
            assert.equal(unsigned.response.status, 401);
            assert.equal(unsigned.json.ResultDesc, 'Invalid callback signature');

            const signed = await request('POST', '/api/payments/mpesa/callback', {
                body,
                headers: {
                    'x-mpesa-signature': signJsonPayload(body, process.env.MPESA_CALLBACK_SECRET)
                }
            });
            assert.equal(signed.response.status, 500);
        });
    } finally {
        if (previousSecret === undefined) {
            delete process.env.MPESA_CALLBACK_SECRET;
        } else {
            process.env.MPESA_CALLBACK_SECRET = previousSecret;
        }
    }
});
