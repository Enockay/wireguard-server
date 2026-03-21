const mongoose = require('mongoose');

const pppoeSecretSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    password: {
        type: String,
        trim: true
    },
    profile: {
        type: String,
        default: 'default',
        trim: true
    },
    service: {
        type: String,
        default: 'pppoe',
        trim: true
    },
    callerIdFilter: {
        type: String,
        default: '*',
        trim: true
    },
    localAddress: {
        type: String,
        trim: true
    },
    remoteAddress: {
        type: String,
        trim: true
    },
    comment: {
        type: String,
        trim: true
    },
    isDisabled: {
        type: Boolean,
        default: false
    },
    routerosId: {
        type: String,
        trim: true
    },
    createdBy: {
        type: String,
        trim: true,
        default: 'admin'
    }
}, {
    timestamps: true,
    collection: 'pppoe_secrets'
});

pppoeSecretSchema.index({ routerId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('PppoeSecret', pppoeSecretSchema);
