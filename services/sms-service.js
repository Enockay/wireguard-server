const AfricasTalking = require('africastalking');
const { log } = require('../wg-core');

const AT_USERNAME = process.env.AT_USERNAME || 'sandbox';
const AT_API_KEY = process.env.AT_API_KEY || '';
const AT_SENDER_ID = process.env.AT_SENDER_ID || '';

let client = null;

function getSmsClient() {
    if (!AT_API_KEY) {
        return null;
    }
    if (!client) {
        client = AfricasTalking({
            apiKey: AT_API_KEY,
            username: AT_USERNAME
        });
    }
    return client.SMS;
}

async function sendSms(to, message) {
    const sms = getSmsClient();
    if (!sms) {
        log('info', 'sms_skipped_not_configured', { to });
        return { skipped: true, reason: 'sms_not_configured' };
    }

    const result = await sms.send({
        to: [String(to).trim()],
        message: String(message || '').trim(),
        from: AT_SENDER_ID || undefined
    });

    log('info', 'sms_sent', {
        to: String(to).trim(),
        recipients: result?.SMSMessageData?.Recipients?.length || 0
    });

    return result;
}

module.exports = {
    sendSms
};
