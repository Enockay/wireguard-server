const mongoose = require('mongoose');

const discoveredDownstreamRouterSchema = new mongoose.Schema({
    ipAddress: { type: String, required: true, trim: true },
    identity: { type: String, default: null },
    platform: { type: String, default: null },
    vendor: { type: String, default: null },
    confidence: {
        type: String,
        enum: ['high', 'medium', 'low'],
        default: 'low'
    },
    evidence: [{ type: String }],
    sourceMethod: [{ type: String }],
    reachable: { type: Boolean, default: false },
    apiReachable: { type: Boolean, default: false },
    sshReachable: { type: Boolean, default: false },
    winboxReachable: { type: Boolean, default: false },
    rosVersion: { type: String, default: null },
    macAddress: { type: String, default: null },
    interfaceContext: { type: String, default: null },
    viaRouter: {
        routerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MikrotikRouter', default: null },
        routerName: { type: String, default: null }
    },
    candidateSubnet: { type: String, default: null },
    notes: { type: String, default: null },
    adoptedRouterId: { type: mongoose.Schema.Types.ObjectId, ref: 'MikrotikRouter', default: null },
    lastSeenAt: { type: Date, default: Date.now }
}, { _id: false });

const downstreamRouterDiscoveryRunSchema = new mongoose.Schema({
    parentRouterId: {
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
    status: {
        type: String,
        enum: ['running', 'completed', 'failed'],
        default: 'running',
        index: true
    },
    dryRun: {
        type: Boolean,
        default: false
    },
    sourceTunnelIp: {
        type: String,
        default: null
    },
    sourceRouterIdentity: {
        type: String,
        default: null
    },
    sourceRouterVersion: {
        type: String,
        default: null
    },
    discoveryMethodUsed: [{ type: String }],
    options: {
        enableNeighborDiscovery: { type: Boolean, default: true },
        enableRouteInspection: { type: Boolean, default: true },
        enableSubnetProbe: { type: Boolean, default: true },
        maxProbeTargets: { type: Number, default: 24 },
        timeoutMs: { type: Number, default: 2500 },
        scanDepth: { type: Number, default: 1 },
        allowedSubnetCidrs: [{ type: String }],
        excludeCidrs: [{ type: String }],
        portPreferences: {
            api: { type: Number, default: 8728 },
            ssh: { type: Number, default: 22 },
            winbox: { type: Number, default: 8291 }
        }
    },
    candidateSubnets: [{ type: String }],
    previewTargets: [{
        ipAddress: { type: String, required: true, trim: true },
        sourceMethod: [{ type: String }],
        candidateSubnet: { type: String, default: null },
        priority: { type: Number, default: 0 },
        evidence: [{ type: String }]
    }],
    candidateSubnetCount: { type: Number, default: 0 },
    probedTargetCount: { type: Number, default: 0 },
    partialVisibility: { type: Boolean, default: false },
    warnings: [{ type: String }],
    errors: [{ type: String }],
    discoveredRouters: {
        type: [discoveredDownstreamRouterSchema],
        default: []
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    completedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true,
    collection: 'downstream_router_discovery_runs'
});

downstreamRouterDiscoveryRunSchema.index({ parentRouterId: 1, createdAt: -1 });

module.exports = mongoose.model('DownstreamRouterDiscoveryRun', downstreamRouterDiscoveryRunSchema);
