const mongoose = require('mongoose');

// Singleton document (always looked up with no filter / upserted) holding
// admin-editable configuration that used to be hardcoded/env-only.
const settingsSchema = new mongoose.Schema({
    routerMonthlyPrice: {
        type: Number,
        default: 10.00,
        min: 0
    },
    trialDays: {
        type: Number,
        default: 7,
        min: 0
    },
    // WireGuard endpoint shown to customers (host:port). Not a secret, just
    // operational config - safe to store here unlike MONGO_URI/JWT_SECRET/etc.
    serverEndpoint: {
        type: String,
        trim: true
    },
    // First 3 octets of this deployment's VPN subnet (e.g. "10.0.0" for
    // 10.0.0.0/24). Must match the wireguard container's WG_SERVER_ADDRESS
    // env var (docker-compose.yml) - changing this here alone does not move
    // the server's own wg0 interface address. A separate deployment (e.g. a
    // test environment) should use a distinct prefix from any other
    // deployment that shares client routers with it, since two deployments
    // reusing the same subnet cause routers holding tunnels to both to
    // misroute replies to whichever one's route wins.
    vpnSubnetPrefix: {
        type: String,
        default: '10.0.0',
        trim: true
    },
    // Public TCP port range for per-router Winbox/SSH/API proxying (see
    // utils/port-allocator.js). Split into three equal sub-ranges at
    // allocation time. Must also be published in docker-compose.yml's
    // `ports:` section on the wireguard service to actually be reachable -
    // changing this here alone does not move the Docker port publish.
    proxyPortRangeStart: {
        type: Number,
        default: 6100,
        min: 1,
        max: 65535
    },
    proxyPortRangeEnd: {
        type: Number,
        default: 6899,
        min: 1,
        max: 65535
    },
    emailSenderName: {
        type: String,
        trim: true
    },
    emailSenderEmail: {
        type: String,
        trim: true
    },
    emailReplyToEmail: {
        type: String,
        trim: true
    },
    // System user credentials pushed to every customer router (used for SSH
    // status monitoring). Real credentials, unlike the fields above - the
    // admin UI treats/masks this one accordingly.
    mikrotikSystemUsername: {
        type: String,
        trim: true
    },
    mikrotikSystemPassword: {
        type: String
    },
    // PayStack integration. Public key is safe to expose client-side (that's
    // its purpose); secret key is a real API credential and is masked in the
    // admin UI the same way mikrotikSystemPassword is.
    paystackPublicKey: {
        type: String,
        trim: true
    },
    paystackSecretKey: {
        type: String
    },
    paystackEnabled: {
        type: Boolean,
        default: false
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true,
    collection: 'settings'
});

settingsSchema.statics.getSingleton = async function() {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({
            routerMonthlyPrice: parseFloat(process.env.ROUTER_MONTHLY_PRICE || '10.00'),
            serverEndpoint: process.env.SERVER_ENDPOINT || '',
            emailSenderName: process.env.BREVO_SENDER_NAME || 'Blackie Networks',
            emailSenderEmail: process.env.BREVO_SENDER_EMAIL || 'noreply@blackie-networks.com',
            emailReplyToEmail: process.env.BREVO_REPLY_TO_EMAIL || 'support@blackie-networks.com',
            mikrotikSystemUsername: process.env.MIKROTIK_SYSTEM_USERNAME || '',
            mikrotikSystemPassword: process.env.MIKROTIK_SYSTEM_PASSWORD || ''
        });
    }
    return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);
