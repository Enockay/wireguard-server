const mongoose = require('mongoose');

const routerMetricSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    cpuLoad: {
        type: Number
    },
    memUsedBytes: {
        type: Number
    },
    memTotalBytes: {
        type: Number
    },
    uptime: {
        type: String
    },
    interfaces: [{
        name: String,
        rxBps: Number,
        txBps: Number,
        running: Boolean,
        rxBytesSnapshot: Number,
        txBytesSnapshot: Number
    }],
    wireguardSummary: {
        available: {
            type: Boolean,
            default: false
        },
        interfaceCount: {
            type: Number,
            default: 0
        },
        peerCount: {
            type: Number,
            default: 0
        },
        activePeerCount: {
            type: Number,
            default: 0
        },
        stalePeerCount: {
            type: Number,
            default: 0
        },
        peersWithNoHandshake: {
            type: Number,
            default: 0
        },
        totalTransferRx: {
            type: Number,
            default: 0
        },
        totalTransferTx: {
            type: Number,
            default: 0
        }
    },
    wireguardPeers: [{
        publicKey: String,
        interface: String,
        endpointAddress: String,
        endpointPort: Number,
        currentEndpointAddress: String,
        currentEndpointPort: Number,
        allowedAddress: String,
        persistentKeepalive: Number,
        lastHandshake: Date,
        handshakeState: String,
        rx: Number,
        tx: Number,
        disabled: Boolean
    }],
    collectionMethod: {
        type: String,
        default: 'api'
    }
}, {
    timestamps: false,
    collection: 'router_metrics'
});

routerMetricSchema.index({ routerId: 1, timestamp: -1 });
routerMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('RouterMetric', routerMetricSchema);
