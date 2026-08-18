const https = require('https');
const crypto = require('crypto');
const { log } = require('../wg-core');

function getSecretKey() {
    const { getConfig } = require('../config-cache');
    const key = getConfig('paystackSecretKey');
    if (!key) {
        throw new Error('PayStack is not configured (no secret key set in Settings)');
    }
    return key;
}

function isConfigured() {
    const { getConfig } = require('../config-cache');
    return !!getConfig('paystackSecretKey') && !!getConfig('paystackEnabled');
}

function paystackRequest(method, path, body) {
    const secretKey = getSecretKey();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.paystack.co',
            path,
            method,
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => { responseData += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(responseData || '{}');
                } catch (e) {
                    return reject(new Error('Failed to parse PayStack response'));
                }
                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.status) {
                    resolve(parsed.data);
                } else {
                    reject(new Error(parsed.message || `PayStack request failed (status ${res.statusCode})`));
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/**
 * Start a PayStack Standard (hosted page) transaction.
 * amountUsd is a plain dollar amount (e.g. 25.00); PayStack wants the
 * smallest currency unit (cents).
 */
async function initializeTransaction({ email, amountUsd, reference, callbackUrl, metadata }) {
    const data = await paystackRequest('POST', '/transaction/initialize', {
        email,
        amount: Math.round(amountUsd * 100),
        currency: 'USD',
        reference,
        callback_url: callbackUrl,
        metadata
    });
    log('info', 'paystack_transaction_initialized', { reference, amountUsd });
    return data; // { authorization_url, access_code, reference }
}

async function verifyTransaction(reference) {
    const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`, null);
    return data; // { status: 'success' | 'failed' | 'abandoned', amount, currency, reference, ... }
}

/**
 * Verifies the x-paystack-signature header against the raw request body.
 * Must be computed over the exact bytes PayStack sent - req.body (already
 * JSON-parsed) is not guaranteed to re-serialize identically.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!rawBody || !signatureHeader) return false;
    const secretKey = getSecretKey();
    const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
    return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature, isConfigured };
