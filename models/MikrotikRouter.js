const mongoose = require('mongoose');

const routerEndpointSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        trim: true
    },
    kind: {
        type: String,
        enum: ['wireguard_api', 'local_api', 'local_api_tls', 'rest_https', 'ssh_fallback', 'public_api_tls'],
        required: true
    },
    host: {
        type: String,
        required: true,
        trim: true
    },
    port: {
        type: Number,
        required: true
    },
    transport: {
        type: String,
        enum: ['api', 'api_ssl', 'rest_https', 'ssh'],
        required: true
    },
    source: {
        type: String,
        enum: ['discovery', 'wireguard', 'manual', 'claim', 'derived'],
        default: 'derived'
    },
    priority: {
        type: Number,
        default: 100
    },
    enabled: {
        type: Boolean,
        default: true
    },
    allowInsecureTls: {
        type: Boolean,
        default: false
    },
    hostValidation: {
        type: String,
        enum: ['strict', 'fingerprint', 'pinned_cert', 'disabled'],
        default: 'strict'
    },
    fingerprint: {
        type: String,
        trim: true,
        default: null
    },
    authScope: {
        type: String,
        enum: ['full', 'read_only', 'unknown'],
        default: 'unknown'
    },
    health: {
        type: String,
        enum: ['unknown', 'healthy', 'degraded', 'unreachable', 'stale'],
        default: 'unknown'
    },
    failureType: {
        type: String,
        enum: ['auth_failed', 'permission_denied', 'endpoint_unreachable', 'api_disabled', 'capability_missing', 'unsafe_operation_blocked', 'stale_endpoint', 'tunnel_not_established', 'tls_validation_failed', 'transport_error', 'timeout'],
        default: null
    },
    consecutiveFailures: {
        type: Number,
        default: 0
    },
    latencyMs: {
        type: Number,
        default: null
    },
    lastCheckedAt: {
        type: Date,
        default: null
    },
    lastSuccessAt: {
        type: Date,
        default: null
    },
    lastFailureAt: {
        type: Date,
        default: null
    }
}, { _id: false });

const routerCapabilitiesSchema = new mongoose.Schema({
    probedAt: { type: Date, default: null },
    authMethod: { type: String, enum: ['api', 'api_ssl', 'rest_https', 'ssh'], default: null },
    principal: { type: String, trim: true, default: null },
    systemRead: { type: Boolean, default: false },
    identityRead: { type: Boolean, default: false },
    interfacesRead: { type: Boolean, default: false },
    queuesRead: { type: Boolean, default: false },
    hotspotRead: { type: Boolean, default: false },
    pppoeRead: { type: Boolean, default: false },
    firewallRead: { type: Boolean, default: false },
    routesRead: { type: Boolean, default: false },
    wireguardRead: { type: Boolean, default: false },
    logsRead: { type: Boolean, default: false },
    queueWrite: { type: Boolean, default: false },
    hotspotWrite: { type: Boolean, default: false },
    pppoeWrite: { type: Boolean, default: false },
    firewallWrite: { type: Boolean, default: false },
    routesWrite: { type: Boolean, default: false },
    interfaceWrite: { type: Boolean, default: false },
    wireguardWrite: { type: Boolean, default: false },
    reboot: { type: Boolean, default: false },
    rawRead: { type: Boolean, default: false },
    rawWrite: { type: Boolean, default: false }
}, { _id: false });

const routerCredentialStateSchema = new mongoose.Schema({
    secretRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RouterCredential',
        default: null
    },
    state: {
        type: String,
        enum: ['unknown', 'active', 'needs_rotation', 'rotating', 'expired', 'revoked'],
        default: 'unknown'
    },
    lastVerifiedAt: { type: Date, default: null },
    lastRotatedAt: { type: Date, default: null },
    nextRotationDueAt: { type: Date, default: null },
    verificationFailureCount: { type: Number, default: 0 }
}, { _id: false });

const routerSafetyPolicySchema = new mongoose.Schema({
    defaultMaxClass: {
        type: String,
        enum: ['read_only', 'safe_operational', 'service_mutation', 'network_core_mutation', 'bootstrap_mutation'],
        default: 'service_mutation'
    },
    allowPublicEndpointWrites: { type: Boolean, default: false },
    allowNetworkCoreWrites: { type: Boolean, default: false },
    allowBootstrap: { type: Boolean, default: false },
    breakGlassRequiredFor: [{
        type: String,
        enum: ['read_only', 'safe_operational', 'service_mutation', 'network_core_mutation', 'bootstrap_mutation']
    }],
    approvedScopes: [{ type: String, trim: true }]
}, { _id: false });

const routerFailureStateSchema = new mongoose.Schema({
    current: {
        type: String,
        enum: ['auth_failed', 'permission_denied', 'endpoint_unreachable', 'api_disabled', 'capability_missing', 'unsafe_operation_blocked', 'stale_endpoint', 'tunnel_not_established', 'tls_validation_failed', 'transport_error', 'timeout'],
        default: null
    },
    firstFailedAt: { type: Date, default: null },
    lastFailedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: null },
    failingEndpointId: { type: String, trim: true, default: null },
    failingTransport: { type: String, trim: true, default: null }
}, { _id: false });

const inventorySnapshotMetaSchema = new mongoose.Schema({
    lastInventorySyncAt: { type: Date, default: null },
    lastInventoryHash: { type: String, trim: true, default: null },
    lastSnapshotAt: { type: Date, default: null },
    lastSnapshotRef: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RouterConfigSnapshot',
        default: null
    },
    adoptedAt: { type: Date, default: null },
    adoptionSource: { type: String, trim: true, default: null }
}, { _id: false });

const routerPingHistorySchema = new mongoose.Schema({
    target: {
        type: String,
        trim: true,
        required: true
    },
    reachable: {
        type: Boolean,
        default: false
    },
    packetsSent: {
        type: Number,
        default: null
    },
    packetsReceived: {
        type: Number,
        default: null
    },
    packetLoss: {
        type: Number,
        default: null
    },
    avgRtt: {
        type: Number,
        default: null
    },
    error: {
        type: String,
        trim: true,
        default: null
    },
    actor: {
        type: String,
        trim: true,
        default: 'system'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const mikrotikRouterSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    // WireGuard client info (links to Client model)
    wireguardClientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: false,
        default: undefined
    },
    // VPN IP assigned to this router
    vpnIp: {
        type: String,
        default: null
    },
    connectionMode: {
        type: String,
        enum: ['wireguard', 'management_only'],
        default: 'wireguard',
        index: true
    },
    managementMode: {
        type: String,
        enum: ['fully_managed', 'management_only'],
        default: 'fully_managed',
        index: true
    },
    serverNode: {
        type: String,
        default: 'wireguard',
        trim: true,
        index: true
    },
    apiUsername: {
        type: String,
        trim: true,
        default: 'admin'
    },
    apiPassword: {
        type: String,
        trim: true,
        default: ''
    },
    apiPort: {
        type: Number,
        default: 8728
    },
    managementEndpoints: {
        type: [routerEndpointSchema],
        default: []
    },
    endpointHealthSummary: {
        type: String,
        enum: ['unknown', 'healthy', 'degraded', 'unreachable', 'stale'],
        default: 'unknown'
    },
    capabilities: {
        type: routerCapabilitiesSchema,
        default: () => ({})
    },
    credentialState: {
        type: routerCredentialStateSchema,
        default: () => ({})
    },
    safetyPolicy: {
        type: routerSafetyPolicySchema,
        default: () => ({})
    },
    failureState: {
        type: routerFailureStateSchema,
        default: () => ({})
    },
    inventorySnapshotMeta: {
        type: inventorySnapshotMetaSchema,
        default: () => ({})
    },
    routerosVersion: {
        type: String,
        trim: true
    },
    lastApiSuccessAt: {
        type: Date
    },
    lastApiErrorAt: {
        type: Date
    },
    lastApiError: {
        type: String,
        trim: true
    },
    // Public ports allocated for this router
    ports: {
        winbox: {
            type: Number,
            required: false
        },
        ssh: {
            type: Number,
            required: false
        },
        api: {
            type: Number,
            required: false
        }
    },
    // Router status
    status: {
        type: String,
        enum: ['pending', 'active', 'inactive', 'offline'],
        default: 'pending',
        index: true
    },
    // Last seen/connected time
    lastSeen: {
        type: Date
    },
    // Connection tracking
    firstConnectedAt: {
        type: Date
    },
    lastSetupGeneratedAt: {
        type: Date
    },
    lastReconfiguredAt: {
        type: Date
    },
    provisioningReviewedAt: {
        type: Date
    },
    provisioningReviewedBy: {
        type: String,
        trim: true
    },
    provisioningError: {
        type: String,
        trim: true
    },
    notes: {
        type: String,
        trim: true
    },
    adminNotes: [{
        body: {
            type: String,
            required: true,
            trim: true
        },
        category: {
            type: String,
            enum: ['support', 'provisioning', 'monitoring', 'billing', 'abuse', 'infrastructure', 'follow_up'],
            default: 'support'
        },
        pinned: {
            type: Boolean,
            default: false
        },
        author: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    internalFlags: [{
        flag: {
            type: String,
            trim: true
        },
        severity: {
            type: String,
            enum: ['low', 'medium', 'high'],
            default: 'medium'
        },
        description: {
            type: String,
            trim: true
        },
        createdBy: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    pingHistory: {
        type: [routerPingHistorySchema],
        default: []
    },
    // Routerboard information (retrieved via API)
    routerboardInfo: {
        uptime: String,
        cpuLoad: String,
        memoryUsage: String,
        totalMemory: String,
        freeMemory: String,
        boardName: String,
        model: String,
        serialNumber: String,
        firmware: String,
        lastChecked: Date
    },
    discoveryInfo: {
        localAddress: {
            type: String,
            trim: true,
            index: true
        },
        subnet: {
            type: String,
            trim: true
        },
        hostname: {
            type: String,
            trim: true
        },
        macAddress: {
            type: String,
            trim: true
        },
        source: {
            type: String,
            trim: true
        },
        discoverySessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'RouterDiscoverySession',
            default: null
        },
        importedAt: {
            type: Date,
            default: null
        },
        importedBy: {
            type: String,
            trim: true
        },
        openPorts: [{
            type: Number
        }]
    }
}, {
    timestamps: true,
    collection: 'mikrotik_routers'
});

// Compound index for user queries
mikrotikRouterSchema.index({ userId: 1, createdAt: -1 });
mikrotikRouterSchema.index({ status: 1, lastSeen: -1 });
mikrotikRouterSchema.index(
    { wireguardClientId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            wireguardClientId: { $type: 'objectId' }
        }
    }
);
mikrotikRouterSchema.index(
    { 'ports.winbox': 1 },
    {
        unique: true,
        partialFilterExpression: {
            'ports.winbox': { $type: 'number' }
        }
    }
);
mikrotikRouterSchema.index(
    { 'ports.ssh': 1 },
    {
        unique: true,
        partialFilterExpression: {
            'ports.ssh': { $type: 'number' }
        }
    }
);
mikrotikRouterSchema.index(
    { 'ports.api': 1 },
    {
        unique: true,
        partialFilterExpression: {
            'ports.api': { $type: 'number' }
        }
    }
);
mikrotikRouterSchema.index({ serverNode: 1, status: 1, createdAt: -1 });
mikrotikRouterSchema.index({ managementMode: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('MikrotikRouter', mikrotikRouterSchema);
