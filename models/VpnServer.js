const mongoose = require('mongoose');

const vpnServerSchema = new mongoose.Schema({
    nodeId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    region: {
        type: String,
        trim: true
    },
    hostname: {
        type: String,
        trim: true
    },
    endpoint: {
        type: String,
        trim: true
    },
    publicKey: {
        type: String,
        trim: true
    },
    controlMode: {
        type: String,
        enum: ['local', 'manual', 'external'],
        default: 'manual',
        index: true
    },
    enabled: {
        type: Boolean,
        default: true,
        index: true
    },
    maintenanceMode: {
        type: Boolean,
        default: false,
        index: true
    },
    status: {
        type: String,
        enum: ['healthy', 'degraded', 'disabled', 'maintenance', 'unknown'],
        default: 'unknown',
        index: true
    },
    maxPeers: {
        type: Number,
        default: 0
    },
    maxRouters: {
        type: Number,
        default: 0
    },
    lastHealthCheckAt: {
        type: Date
    },
    lastHeartbeatAt: {
        type: Date
    },
    lastRestartAt: {
        type: Date
    },
    lastReconcileAt: {
        type: Date
    },
    reviewedAt: {
        type: Date
    },
    reviewedBy: {
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
            enum: ['infrastructure', 'capacity', 'maintenance', 'migration', 'monitoring', 'incident', 'follow_up'],
            default: 'infrastructure'
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
    }]
}, {
    timestamps: true,
    collection: 'vpn_servers'
});

vpnServerSchema.index({ enabled: 1, maintenanceMode: 1, status: 1 });
vpnServerSchema.index({ region: 1, createdAt: -1 });

module.exports = mongoose.model('VpnServer', vpnServerSchema);
