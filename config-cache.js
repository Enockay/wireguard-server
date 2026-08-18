// In-memory cache for admin-editable settings (models/Settings.js) that are
// read synchronously in many places (getServerEndpoint() alone has ~10
// call sites). Rather than make every caller async, we keep a plain object
// in memory, populated at startup and refreshed immediately after any
// admin settings save - so changes take effect live, without a restart.
let cache = {};

async function refreshConfigCache() {
    const Settings = require('./models/Settings');
    const settings = await Settings.getSingleton();
    cache = {
        serverEndpoint: settings.serverEndpoint,
        proxyPortRangeStart: settings.proxyPortRangeStart,
        proxyPortRangeEnd: settings.proxyPortRangeEnd,
        emailSenderName: settings.emailSenderName,
        emailSenderEmail: settings.emailSenderEmail,
        emailReplyToEmail: settings.emailReplyToEmail,
        mikrotikSystemUsername: settings.mikrotikSystemUsername,
        mikrotikSystemPassword: settings.mikrotikSystemPassword,
        paystackPublicKey: settings.paystackPublicKey,
        paystackSecretKey: settings.paystackSecretKey,
        paystackEnabled: settings.paystackEnabled
    };
    return cache;
}

function getConfig(key) {
    return cache[key];
}

module.exports = { refreshConfigCache, getConfig };
