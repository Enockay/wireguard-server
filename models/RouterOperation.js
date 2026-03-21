const mongoose = require('mongoose');

const routerOperationSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    actor: {
        type: String,
        trim: true,
        default: 'system'
    },
    actorType: {
        type: String,
        enum: ['admin', 'user', 'system', 'worker'],
        default: 'system'
    },
    requestId: {
        type: String,
        trim: true,
        default: null
    },
    operationName: {
        type: String,
        required: true,
        trim: true
    },
    endpointId: {
        type: String,
        trim: true,
        default: null
    },
    endpointKind: {
        type: String,
        trim: true,
        default: null
    },
    protocol: {
        type: String,
        trim: true,
        default: null
    },
    commandClass: {
        type: String,
        enum: ['read_only', 'safe_operational', 'service_mutation', 'network_core_mutation', 'bootstrap_mutation'],
        required: true
    },
    capabilityRequired: {
        type: String,
        trim: true,
        default: null
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    durationMs: {
        type: Number,
        default: 0
    },
    retries: {
        type: Number,
        default: 0
    },
    outcome: {
        type: String,
        enum: ['pending', 'success', 'failed', 'blocked', 'rolled_back'],
        default: 'pending'
    },
    failureType: {
        type: String,
        default: null
    },
    errorCode: {
        type: String,
        default: null
    },
    errorMessage: {
        type: String,
        default: null
    },
    snapshotRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RouterConfigSnapshot',
        default: null
    },
    rollbackRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RouterConfigSnapshot',
        default: null
    },
    inventoryVersion: {
        type: String,
        default: null
    },
    transportChain: [{
        endpointId: String,
        protocol: String,
        failureType: String
    }],
    dryRun: {
        type: Boolean,
        default: false
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, {
    timestamps: false,
    collection: 'router_operations'
});

routerOperationSchema.index({ routerId: 1, startedAt: -1 });

module.exports = mongoose.model('RouterOperation', routerOperationSchema);
