const mongoose = require('mongoose');

const routerConfigSnapshotSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    operationName: {
        type: String,
        required: true,
        trim: true
    },
    scope: {
        type: String,
        required: true,
        trim: true
    },
    endpointId: {
        type: String,
        trim: true,
        default: null
    },
    protocol: {
        type: String,
        trim: true,
        default: null
    },
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    hash: {
        type: String,
        trim: true,
        default: null
    },
    createdBy: {
        type: String,
        trim: true,
        default: 'system'
    },
    rollbackSupported: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    collection: 'router_config_snapshots'
});

routerConfigSnapshotSchema.index({ routerId: 1, createdAt: -1 });

module.exports = mongoose.model('RouterConfigSnapshot', routerConfigSnapshotSchema);
