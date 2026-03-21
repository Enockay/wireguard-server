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
