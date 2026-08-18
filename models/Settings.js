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
