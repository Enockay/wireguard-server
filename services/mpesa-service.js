const axios = require('axios');

const MPESA_SANDBOX = !['0', 'false', 'no', 'off'].includes(String(process.env.MPESA_SANDBOX || 'true').toLowerCase());
const MPESA_BASE_URL = MPESA_SANDBOX
    ? 'https://sandbox.safaricom.co.ke'
    : 'https://api.safaricom.co.ke';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not configured`);
    }
    return value;
}

function formatPhoneNumber(phoneNumber) {
    const digits = String(phoneNumber || '').replace(/\D/g, '');
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('07') && digits.length === 10) return `254${digits.slice(1)}`;
    if (digits.startsWith('7') && digits.length === 9) return `254${digits}`;
    throw new Error('Phone number must be in 254XXXXXXXXX or 07XXXXXXXX format');
}

function getTimestamp() {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');
}

async function getAccessToken() {
    if (cachedToken && cachedTokenExpiresAt > Date.now()) {
        return cachedToken;
    }

    const consumerKey = requireEnv('MPESA_CONSUMER_KEY');
    const consumerSecret = requireEnv('MPESA_CONSUMER_SECRET');
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: {
            Authorization: `Basic ${auth}`
        },
        timeout: 10000
    });

    cachedToken = response.data?.access_token || '';
    cachedTokenExpiresAt = Date.now() + (3500 * 1000);
    return cachedToken;
}

async function initiateStk(phoneNumber, amount, accountRef, description) {
    const accessToken = await getAccessToken();
    const shortcode = requireEnv('MPESA_SHORTCODE');
    const passkey = requireEnv('MPESA_PASSKEY');
    const callbackUrl = requireEnv('MPESA_CALLBACK_URL');
    const timestamp = getTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
    const formattedPhone = formatPhoneNumber(phoneNumber);

    const response = await axios.post(
        `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
        {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.max(1, Math.round(Number(amount || 0))),
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: callbackUrl,
            AccountReference: String(accountRef || 'Subscription').slice(0, 20),
            TransactionDesc: String(description || 'Subscription payment').slice(0, 60)
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return {
        CheckoutRequestID: response.data?.CheckoutRequestID,
        ResponseCode: response.data?.ResponseCode,
        ResponseDescription: response.data?.ResponseDescription,
        CustomerMessage: response.data?.CustomerMessage
    };
}

async function queryStk(checkoutRequestId) {
    const accessToken = await getAccessToken();
    const shortcode = requireEnv('MPESA_SHORTCODE');
    const passkey = requireEnv('MPESA_PASSKEY');
    const timestamp = getTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    const response = await axios.post(
        `${MPESA_BASE_URL}/mpesa/stkpush/v1/query`,
        {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            CheckoutRequestID: checkoutRequestId
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return {
        ResultCode: response.data?.ResultCode,
        ResultDesc: response.data?.ResultDesc,
        CheckoutRequestID: response.data?.CheckoutRequestID
    };
}

module.exports = {
    getAccessToken,
    initiateStk,
    queryStk,
    formatPhoneNumber
};
