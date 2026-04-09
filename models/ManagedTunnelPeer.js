const mongoose = require('mongoose');

const managedTunnelPeerSightingSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true
    },
    routerName: {
        type: String,
        trim: true,
        default: null
    },
    interfaceName: {
        type: String,
        trim: true,
        default: null
    },
    endpoint: {
        type: String,
        trim: true,
        default: null
    },
    allowedIPs: {
        type: [String],
        default: []
    },
    lastSeenAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const managedTunnelPeerEvidenceSchema = new mongoose.Schema({
    kind: {
        type: String,
        enum: ['runtime_observation', 'manual_classification', 'downstream_discovery', 'heuristic', 'promotion'],
        required: true
    },
    summary: {
        type: String,
        required: true,
        trim: true
    },
    confidence: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
    },
    sourceRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        default: null
    },
    observedAt: {
        type: Date,
        default: Date.now
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, { _id: false });

const managedTunnelPeerSchema = new mongoose.Schema({
    ownerUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    publicKey: {
        type: String,
        required: true,
        trim: true
    },
    assetLabel: {
        type: String,
        trim: true,
        default: null
    },
    interfaceName: {
        type: String,
        trim: true,
        default: null
    },
    endpoint: {
        type: String,
        trim: true,
        default: null
    },
    allowedIPs: {
        type: [String],
        default: []
    },
    sourceRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true
    },
    lastSeenAt: {
        type: Date,
        default: Date.now
    },
    seenOnRouters: {
        type: [managedTunnelPeerSightingSchema],
        default: []
    },
    classification: {
        type: String,
        enum: ['mikrotik_router', 'wireguard_service', 'site_gateway', 'unknown'],
        default: 'unknown'
    },
    classificationSource: {
        type: String,
        enum: ['manual', 'heuristic', 'discovery', 'mixed'],
        default: 'manual'
    },
    confidenceScore: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
    },
    promotionEligible: {
        type: Boolean,
        default: false
    },
    promotionReadinessReason: {
        type: String,
        trim: true,
        default: null
    },
    evidence: {
        type: [managedTunnelPeerEvidenceSchema],
        default: []
    },
    promotedRouterIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter'
    }],
    notes: {
        type: String,
        trim: true,
        default: ''
    }
}, {
    timestamps: true,
    collection: 'managed_tunnel_peers'
});

managedTunnelPeerSchema.index({ ownerUserId: 1, publicKey: 1 }, { unique: true });
managedTunnelPeerSchema.index({ ownerUserId: 1, classification: 1, lastSeenAt: -1 });

module.exports = mongoose.model('ManagedTunnelPeer', managedTunnelPeerSchema);
