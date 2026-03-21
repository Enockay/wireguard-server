const mongoose = require('mongoose');

const verificationInterfaceSchema = new mongoose.Schema({
    name: {
        type: String,
        default: 'unknown'
    },
    type: {
        type: String,
        default: 'unknown'
    },
    running: {
        type: Boolean,
        default: false
    },
    disabled: {
        type: Boolean,
        default: false
    },
    comment: {
        type: String,
        default: ''
    }
}, { _id: false });

const verificationMetadataSchema = new mongoose.Schema({
    identity: { type: String, default: null },
    boardName: { type: String, default: null },
    serialNumber: { type: String, default: null },
    routerosVersion: { type: String, default: null },
    firmware: { type: String, default: null },
    model: { type: String, default: null },
    macAddress: { type: String, default: null },
    interfaces: {
        type: [verificationInterfaceSchema],
        default: []
    },
    interfaceCount: { type: Number, default: 0 },
    raw: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, { _id: false });

const verificationSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: ['unverified', 'verified', 'failed', 'unsupported', 'duplicate', 'imported'],
        default: 'unverified'
    },
    method: {
        type: String,
        trim: true,
        default: null
    },
    verifiedAt: {
        type: Date,
        default: null
    },
    expiresAt: {
        type: Date,
        default: null
    },
    credentials: {
        username: {
            type: String,
            trim: true,
            default: null
        },
        credentialSecretRef: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'RouterCredential',
            default: null
        },
        apiPort: {
            type: Number,
            default: null
        }
    },
    metadata: {
        type: verificationMetadataSchema,
        default: null
    },
    readiness: {
        status: {
            type: String,
            enum: ['ready', 'warning', 'blocked'],
            default: 'warning'
        },
        reasons: [{ type: String }],
        apiReachable: { type: Boolean, default: false },
        sshReachable: { type: Boolean, default: false },
        winboxReachable: { type: Boolean, default: false },
        wireGuardReady: { type: Boolean, default: false },
        duplicateRouterId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'MikrotikRouter',
            default: null
        }
    },
    error: {
        type: String,
        default: null
    }
}, { _id: false });

const candidateSchema = new mongoose.Schema({
    ipAddress: {
        type: String,
        required: true,
        trim: true
    },
    subnet: {
        type: String,
        default: null
    },
    hostname: {
        type: String,
        default: null
    },
    macAddress: {
        type: String,
        default: null
    },
    vendor: {
        type: String,
        default: null
    },
    openPorts: [{
        type: Number
    }],
    detectedServices: [{
        type: String
    }],
    isLikelyMikrotik: {
        type: Boolean,
        default: false
    },
    confidence: {
        type: Number,
        default: 0
    },
    discoverySource: {
        type: String,
        default: 'server'
    },
    scannedAt: {
        type: Date,
        default: Date.now
    },
    verification: {
        type: verificationSchema,
        default: () => ({})
    },
    importedRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        default: null
    },
    importedAt: {
        type: Date,
        default: null
    }
}, { timestamps: false });

const routerDiscoverySessionSchema = new mongoose.Schema({
    adminUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    source: {
        type: String,
        enum: ['server', 'agent'],
        default: 'server'
    },
    status: {
        type: String,
        enum: ['pending', 'scanning', 'completed', 'failed', 'expired'],
        default: 'pending',
        index: true
    },
    requestedSubnet: {
        type: String,
        default: null
    },
    scannedSubnets: [{
        type: String
    }],
    reason: {
        type: String,
        default: ''
    },
    hostCountScanned: {
        type: Number,
        default: 0
    },
    candidateCount: {
        type: Number,
        default: 0
    },
    truncatedReason: {
        type: String,
        default: null
    },
    error: {
        type: String,
        default: null
    },
    truncated: {
        type: Boolean,
        default: false
    },
    scanStartedAt: {
        type: Date,
        default: Date.now
    },
    scanCompletedAt: {
        type: Date,
        default: null
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 60 * 1000),
        index: true
    },
    candidates: [candidateSchema]
}, {
    timestamps: true,
    collection: 'router_discovery_sessions'
});

routerDiscoverySessionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('RouterDiscoverySession', routerDiscoverySessionSchema);
