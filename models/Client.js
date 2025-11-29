const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        index: true,
        lowercase: true
    },
    ip: {
        type: String,
        required: true,
        unique: true,
        validate: {
            validator: function(v) {
                return /^10\.0\.0\.\d{1,3}\/32$/.test(v);
            },
            message: 'IP must be in format 10.0.0.X/32'
        }
    },
    publicKey: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    privateKey: {
        type: String,
        required: true,
        trim: true
    },
    enabled: {
        type: Boolean,
        default: true,
        index: true
    },
    createdBy: {
        type: String,
        default: 'system'
    },
    notes: {
        type: String,
        trim: true
    },
    interfaceName: {
        type: String,
        trim: true
    },
    endpoint: {
        type: String,
        trim: true
    },
    allowedIPs: {
        type: String,
        default: '0.0.0.0/0',
        trim: true
    },
    dns: {
        type: String,
        trim: true
    },
    persistentKeepalive: {
        type: Number,
        default: 25
    },
    // Real-time connection statistics (updated from WireGuard interface)
    lastHandshake: {
        type: Date
    },
    transferRx: {
        type: Number,
        default: 0
    },
    transferTx: {
        type: Number,
        default: 0
    },
    lastConnectionTime: {
        type: Date
    },
    lastConnectionIp: {
        type: String,
        trim: true
    }
}, {
    timestamps: true, // Adds createdAt and updatedAt
    collection: 'wireguard_clients'
});

// Index for faster queries
clientSchema.index({ enabled: 1, name: 1 });
clientSchema.index({ createdAt: -1 });
clientSchema.index({ publicKey: 1 }); // For statistics matching

// Ensure name is lowercase (Mongoose 7+ uses promise-based middleware, no next callback)
clientSchema.pre('save', function() {
    if (this.name) {
        this.name = this.name.toLowerCase();
    }
});

// Method to get safe version (without private key)
clientSchema.methods.toSafeJSON = function() {
    const obj = this.toObject();
    delete obj.privateKey;
    return obj;
};

module.exports = mongoose.model('Client', clientSchema);

