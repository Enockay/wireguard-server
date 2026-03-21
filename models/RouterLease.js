const mongoose = require('mongoose');

const routerLeaseSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    jobType: {
        type: String,
        required: true,
        trim: true
    },
    ownerId: {
        type: String,
        required: true,
        trim: true
    },
    expiresAt: {
        type: Date,
        required: true,
        index: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, {
    timestamps: true,
    collection: 'router_leases'
});

routerLeaseSchema.index({ routerId: 1, jobType: 1 }, { unique: true });
routerLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RouterLease', routerLeaseSchema);
