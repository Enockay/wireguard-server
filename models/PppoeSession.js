const mongoose = require('mongoose');

const pppoeSessionSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    name: {
        type: String,
        trim: true
    },
    service: {
        type: String,
        trim: true
    },
    callerIp: {
        type: String,
        trim: true
    },
    address: {
        type: String,
        trim: true
    },
    uptime: {
        type: String,
        trim: true
    },
    bytesIn: {
        type: Number,
        default: 0
    },
    bytesOut: {
        type: Number,
        default: 0
    },
    sessionId: {
        type: String,
        trim: true
    },
    connectedAt: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    collection: 'pppoe_sessions'
});

pppoeSessionSchema.index({ routerId: 1, isActive: 1 });

module.exports = mongoose.model('PppoeSession', pppoeSessionSchema);
