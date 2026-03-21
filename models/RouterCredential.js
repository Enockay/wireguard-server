const mongoose = require('mongoose');

const routerCredentialSchema = new mongoose.Schema({
    routerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MikrotikRouter',
        default: null,
        index: true
    },
    scope: {
        type: String,
        enum: ['router_access', 'discovery_verification', 'rotation_pending'],
        default: 'router_access',
        index: true
    },
    state: {
        type: String,
        enum: ['pending', 'active', 'superseded', 'revoked', 'failed'],
        default: 'active',
        index: true
    },
    principal: {
        type: String,
        required: true,
        trim: true
    },
    secretCiphertext: {
        type: String,
        required: true
    },
    secretIv: {
        type: String,
        required: true
    },
    secretAuthTag: {
        type: String,
        required: true
    },
    keyVersion: {
        type: String,
        default: 'v1'
    },
    metadata: {
        transportHint: {
            type: String,
            enum: ['api', 'api_ssl', 'rest_https', 'ssh', 'unknown'],
            default: 'unknown'
        },
        apiPort: {
            type: Number,
            default: null
        },
        username: {
            type: String,
            trim: true,
            default: null
        }
    },
    createdBy: {
        type: String,
        trim: true,
        default: 'system'
    },
    verifiedAt: {
        type: Date,
        default: null
    },
    rotatedAt: {
        type: Date,
        default: null
    },
    revokedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true,
    collection: 'router_credentials'
});

routerCredentialSchema.index({ routerId: 1, state: 1, createdAt: -1 });

module.exports = mongoose.model('RouterCredential', routerCredentialSchema);
