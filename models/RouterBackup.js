const mongoose = require('mongoose');

const routerBackupSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        required: true,
        index: true
    },
    filename: {
        type: String,
        required: true,
        trim: true
    },
    exportText: {
        type: String,
        default: ''
    },
    sizeBytes: {
        type: Number,
        default: 0
    },
    triggeredBy: {
        type: String,
        enum: ['manual', 'auto', 'pre-change'],
        default: 'manual'
    },
    createdBy: {
        type: String,
        trim: true,
        default: 'system'
    },
    note: {
        type: String,
        trim: true,
        default: ''
    },
    metadata: {
        routerosVersion: {
            type: String,
            trim: true,
            default: null
        },
        boardName: {
            type: String,
            trim: true,
            default: null
        },
        model: {
            type: String,
            trim: true,
            default: null
        },
        serialNumber: {
            type: String,
            trim: true,
            default: null
        },
        restoreCompatible: {
            type: Boolean,
            default: true
        },
        lastRestoreTestAt: {
            type: Date,
            default: null
        },
        restoreValidationSignals: {
            type: [String],
            default: []
        }
    }
}, {
    timestamps: true,
    collection: 'router_backups'
});

routerBackupSchema.index({ routerId: 1, createdAt: -1 });
routerBackupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('RouterBackup', routerBackupSchema);
