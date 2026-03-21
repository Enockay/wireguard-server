const mongoose = require('mongoose');

const routerInventorySchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    domain: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    itemKey: {
        type: String,
        required: true,
        trim: true
    },
    routerosId: {
        type: String,
        default: null
    },
    normalized: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    raw: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    hash: {
        type: String,
        trim: true,
        default: null
    },
    syncedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: false,
    collection: 'router_inventory'
});

routerInventorySchema.index({ routerId: 1, domain: 1, itemKey: 1 }, { unique: true });
routerInventorySchema.index({ routerId: 1, syncedAt: -1 });

module.exports = mongoose.model('RouterInventory', routerInventorySchema);
