const mongoose = require('mongoose');

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
        required: true,
        unique: true
    },
    // VPN IP assigned to this router
    vpnIp: {
        type: String,
        required: true
    },
    serverNode: {
        type: String,
        default: 'wireguard',
        trim: true,
        index: true
    },
    // Public ports allocated for this router
    ports: {
        winbox: {
            type: Number,
            required: true,
            unique: true,
            index: true
        },
        ssh: {
            type: Number,
            required: true,
            unique: true,
            index: true
        },
        api: {
            type: Number,
            required: true,
            unique: true,
            index: true
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
    }
}, {
    timestamps: true,
    collection: 'mikrotik_routers'
});

// Compound index for user queries
mikrotikRouterSchema.index({ userId: 1, createdAt: -1 });
mikrotikRouterSchema.index({ status: 1, lastSeen: -1 });
mikrotikRouterSchema.index({ serverNode: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('MikrotikRouter', mikrotikRouterSchema);
