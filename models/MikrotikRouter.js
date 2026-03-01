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
    notes: {
        type: String,
        trim: true
    }
}, {
    timestamps: true,
    collection: 'mikrotik_routers'
});

// Compound index for user queries
mikrotikRouterSchema.index({ userId: 1, createdAt: -1 });
mikrotikRouterSchema.index({ status: 1, lastSeen: -1 });

module.exports = mongoose.model('MikrotikRouter', mikrotikRouterSchema);
