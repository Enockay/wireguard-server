const mongoose = require('mongoose');

const routerLocationSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    // Geographic coordinates
    latitude: {
        type: Number,
        required: false,
        min: -90,
        max: 90
    },
    longitude: {
        type: Number,
        required: false,
        min: -180,
        max: 180
    },
    // Location metadata
    address: {
        type: String,
        trim: true,
        default: null
    },
    country: {
        type: String,
        trim: true,
        default: null
    },
    region: {
        type: String,
        trim: true,
        default: null
    },
    city: {
        type: String,
        trim: true,
        default: null
    },
    isp: {
        type: String,
        trim: true,
        default: null
    },
    // Connection info
    publicIp: {
        type: String,
        trim: true,
        default: null
    },
    asn: {
        type: String,
        trim: true,
        default: null
    },
    // Source of geolocation
    source: {
        type: String,
        enum: ['manual', 'geolocation_service', 'gps', 'user_provided'],
        default: 'user_provided'
    },
    // Timestamp info
    lastUpdated: {
        type: Date,
        default: null
    },
    verifiedAt: {
        type: Date,
        default: null
    },
    // Accuracy
    accuracy: {
        type: Number,
        default: null // In meters
    }
}, {
    timestamps: true,
    collection: 'router_locations'
});

// Index for geographic queries
routerLocationSchema.index({ latitude: 1, longitude: 1 });
routerLocationSchema.index({ country: 1 });
routerLocationSchema.index({ routerId: 1 });

module.exports = mongoose.model('RouterLocation', routerLocationSchema);
