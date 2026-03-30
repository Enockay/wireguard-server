const mongoose = require('mongoose');

const routerQueueSchema = new mongoose.Schema({
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
    target: {
        type: String,
        trim: true
    },
    maxDownloadKbps: {
        type: Number,
        default: 0
    },
    maxUploadKbps: {
        type: Number,
        default: 0
    },
    burstDownloadKbps: {
        type: Number,
        default: 0
    },
    burstUploadKbps: {
        type: Number,
        default: 0
    },
    comment: {
        type: String,
        trim: true
    },
    routerosId: {
        type: String,
        trim: true
    },
    isDynamic: {
        type: Boolean,
        default: false
    },
    linkedSubscriptionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription'
    },
    linkedServicePlanId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServicePlan'
    },
    overrideSourceType: {
        type: String,
        enum: ['hotspot_user', 'pppoe_secret', 'manual'],
        trim: true
    },
    overrideSourceId: {
        type: String,
        trim: true
    },
    overrideSourceName: {
        type: String,
        trim: true
    },
    queueType: {
        type: String,
        enum: ['simple', 'pcq'],
        default: 'simple'
    },
    pcqDownloadProfile: {
        type: String,
        trim: true
    },
    pcqUploadProfile: {
        type: String,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: String,
        default: 'system',
        trim: true
    }
}, {
    timestamps: true,
    collection: 'router_queues'
});

routerQueueSchema.index({ routerId: 1, target: 1 });

module.exports = mongoose.model('RouterQueue', routerQueueSchema);
