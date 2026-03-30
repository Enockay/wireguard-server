const mongoose = require('mongoose');

const connectedDeviceSchema = new mongoose.Schema({
    // Source router (parent)
    parentRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    // Connected device/router info
    deviceId: {
        type: String,
        required: true,
        index: true
    },
    identityKey: {
        type: String,
        trim: true,
        default: null,
        index: true
    },
    deviceName: {
        type: String,
        trim: true,
        default: null
    },
    deviceType: {
        type: String,
        enum: ['access_point', 'router', 'client', 'switch', 'unknown'],
        default: 'unknown'
    },
    classificationConfidence: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    classificationEvidence: {
        type: [String],
        default: []
    },
    // Connection details
    ipAddress: {
        type: String,
        required: true
    },
    macAddress: {
        type: String,
        trim: true,
        default: null
    },
    // SSH Key or Public Key (for identifying peers)
    publicKey: {
        type: String,
        trim: true,
        default: null
    },
    // Interface info
    interfaceName: {
        type: String,
        trim: true,
        default: null
    },
    signal: {
        type: Number,
        default: null // RSSI for wireless
    },
    // Connection quality metrics
    bandwidth: {
        type: Number,
        default: null // In Mbps
    },
    latency: {
        type: Number,
        default: null // In ms
    },
    packetLoss: {
        type: Number,
        default: 0 // Percentage
    },
    connectionUptime: {
        type: Number,
        default: 0 // In seconds
    },
    // Status
    isOnline: {
        type: Boolean,
        default: true
    },
    lastSeen: {
        type: Date,
        default: Date.now
    },
    lastConnected: {
        type: Date,
        default: Date.now
    },
    disconnectCount: {
        type: Number,
        default: 0
    },
    // Hardware info
    manufacturer: {
        type: String,
        trim: true,
        default: null
    },
    model: {
        type: String,
        trim: true,
        default: null
    },
    firmware: {
        type: String,
        trim: true,
        default: null
    },
    // Geographic location of device
    latitude: {
        type: Number,
        default: null,
        min: -90,
        max: 90
    },
    longitude: {
        type: Number,
        default: null,
        min: -180,
        max: 180
    },
    location: {
        type: String,
        trim: true,
        default: null
    },
    // Metadata
    notes: {
        type: String,
        trim: true,
        default: null
    },
    customLabel: {
        type: String,
        trim: true,
        default: null
    },
    // Virtual connection tracking
    isManagedByUser: {
        type: Boolean,
        default: false
    },
    trackedRouterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        default: null // If this device is actually a router we manage
    },
    discoverySource: {
        type: String,
        enum: ['wireless', 'arp', 'bgp', 'neighbor', 'wireguard', 'pppoe', 'hotspot', 'manual', 'unknown'],
        default: 'manual',
        index: true
    }
}, {
    timestamps: true,
    collection: 'connected_devices'
});

// Composite index for quickly finding devices connected to a parent
connectedDeviceSchema.index({ parentRouterId: 1, isOnline: 1 });
connectedDeviceSchema.index({ parentRouterId: 1, lastSeen: -1 });
connectedDeviceSchema.index({ parentRouterId: 1, discoverySource: 1, identityKey: 1 });
connectedDeviceSchema.index({ ipAddress: 1 });

module.exports = mongoose.model('ConnectedDevice', connectedDeviceSchema);
