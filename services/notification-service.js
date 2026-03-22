const { sendSms } = require('./sms-service');
const { sendEmail, sendBillingReminderEmail } = require('./email-service');
const { log } = require('../wg-core');

function formatAmount(amount, currency = 'USD') {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

async function sendNotificationEmail(user, subject, htmlContent, textContent) {
    if (!user?.email) {
        return { skipped: true, reason: 'missing_email' };
    }
    return sendEmail({
        to: user.email,
        subject,
        htmlContent,
        textContent
    });
}

async function notifySubscriptionExpiring(user, router, daysLeft) {
    const message = `Hi ${user.name}, your Blackie Networks router ${router.name} subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Pay now to avoid interruption.`;
    const emailPromise = user?.email
        ? sendBillingReminderEmail(user, {
            reference: router.name,
            dueDate: new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000),
            message
        })
        : Promise.resolve({ skipped: true, reason: 'missing_email' });
    const smsPromise = user?.phone ? sendSms(user.phone, message) : Promise.resolve({ skipped: true, reason: 'missing_phone' });
    const result = await Promise.allSettled([emailPromise, smsPromise]);
    log('info', 'notify_subscription_expiring_sent', { userId: user?._id, routerId: router?._id, daysLeft });
    return result;
}

async function notifySubscriptionExpired(user, router) {
    const message = `Your router ${router.name} service has been suspended due to non-payment.`;
    const htmlContent = `<p>Hello ${user.name},</p><p>${message}</p>`;
    const textContent = `Hello ${user.name},\n\n${message}`;
    const result = await Promise.allSettled([
        sendNotificationEmail(user, 'Subscription Suspended - Blackie Networks', htmlContent, textContent),
        user?.phone ? sendSms(user.phone, message) : Promise.resolve({ skipped: true, reason: 'missing_phone' })
    ]);
    log('info', 'notify_subscription_expired_sent', { userId: user?._id, routerId: router?._id });
    return result;
}

async function notifyPaymentConfirmed(user, router, amount) {
    const message = `Payment of ${formatAmount(amount, user?.currency || 'USD')} confirmed. Your router ${router.name} is now active.`;
    const htmlContent = `<p>Hello ${user.name},</p><p>${message}</p>`;
    const textContent = `Hello ${user.name},\n\n${message}`;
    const result = await Promise.allSettled([
        sendNotificationEmail(user, 'Payment Confirmed - Blackie Networks', htmlContent, textContent),
        user?.phone ? sendSms(user.phone, message) : Promise.resolve({ skipped: true, reason: 'missing_phone' })
    ]);
    log('info', 'notify_payment_confirmed_sent', { userId: user?._id, routerId: router?._id, amount });
    return result;
}

async function notifyRouterOffline(user, router) {
    const message = `Alert: Your router ${router.name} appears to be offline.`;
    const htmlContent = `<p>Hello ${user.name},</p><p>${message}</p>`;
    const textContent = `Hello ${user.name},\n\n${message}`;
    const result = await Promise.allSettled([
        sendNotificationEmail(user, 'Router Offline Alert - Blackie Networks', htmlContent, textContent),
        user?.phone ? sendSms(user.phone, message) : Promise.resolve({ skipped: true, reason: 'missing_phone' })
    ]);
    log('info', 'notify_router_offline_sent', { userId: user?._id, routerId: router?._id });
    return result;
}

module.exports = {
    notifySubscriptionExpiring,
    notifySubscriptionExpired,
    notifyPaymentConfirmed,
    notifyRouterOffline
};
