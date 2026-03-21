const crypto = require('crypto');
const RouterCredential = require('../models/RouterCredential');
const MikrotikRouter = require('../models/MikrotikRouter');

const DEFAULT_PORT_BY_TRANSPORT = {
    api: 8728,
    api_ssl: 8729,
    rest_https: 443,
    ssh: 22
};

function getMasterKey() {
    const raw = String(process.env.ROUTER_SECRET_MASTER_KEY || process.env.ENCRYPTION_KEY || '').trim();
    if (!raw) {
        return crypto.createHash('sha256').update('unsafe-dev-router-secret-key').digest();
    }

    if (/^[a-fA-F0-9]{64}$/.test(raw)) {
        return Buffer.from(raw, 'hex');
    }

    return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        secretCiphertext: ciphertext.toString('base64'),
        secretIv: iv.toString('base64'),
        secretAuthTag: authTag.toString('base64'),
        keyVersion: 'v1'
    };
}

function decryptSecret(credential) {
    if (!credential?.secretCiphertext || !credential?.secretIv || !credential?.secretAuthTag) {
        return '';
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getMasterKey(),
        Buffer.from(credential.secretIv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(credential.secretAuthTag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(credential.secretCiphertext, 'base64')),
        decipher.final()
    ]);
    return plaintext.toString('utf8');
}

async function createCredential({
    routerId = null,
    scope = 'router_access',
    principal,
    secret,
    transportHint = 'unknown',
    apiPort = null,
    username = null,
    createdBy = 'system',
    state = 'active'
}) {
    const encrypted = encryptSecret(secret);
    return RouterCredential.create({
        routerId,
        scope,
        state,
        principal: String(principal || username || '').trim() || 'admin',
        ...encrypted,
        metadata: {
            transportHint,
            apiPort: apiPort || DEFAULT_PORT_BY_TRANSPORT[transportHint] || null,
            username: username || principal || 'admin'
        },
        createdBy
    });
}

async function attachCredentialToRouter(routerId, credential, { state = 'active' } = {}) {
    await MikrotikRouter.findByIdAndUpdate(routerId, {
        'credentialState.secretRef': credential?._id || null,
        'credentialState.state': state,
        'credentialState.lastRotatedAt': new Date(),
        'credentialState.verificationFailureCount': 0
    }).catch(() => undefined);
}

async function getCredentialDocument(router) {
    if (!router) return null;

    if (router.credentialState?.secretRef) {
        return RouterCredential.findById(router.credentialState.secretRef);
    }

    if ((router.apiPassword || '') !== '' || (router.apiUsername || '').trim()) {
        return {
            _id: null,
            principal: router.apiUsername || 'admin',
            metadata: {
                apiPort: router.apiPort || 8728,
                username: router.apiUsername || 'admin',
                transportHint: 'api'
            },
            __legacyPlaintext: true,
            get decryptedSecret() {
                return router.apiPassword || '';
            }
        };
    }

    return null;
}

async function getResolvedCredential(router) {
    const credential = await getCredentialDocument(router);
    if (!credential) return null;
    return {
        id: credential._id || null,
        principal: credential.principal || credential.metadata?.username || router?.apiUsername || 'admin',
        username: credential.metadata?.username || credential.principal || router?.apiUsername || 'admin',
        password: credential.__legacyPlaintext ? credential.decryptedSecret : decryptSecret(credential),
        apiPort: credential.metadata?.apiPort || router?.apiPort || 8728,
        transportHint: credential.metadata?.transportHint || 'api'
    };
}

async function rotateCredential({
    router,
    principal,
    secret,
    transportHint = 'api',
    apiPort = null,
    createdBy = 'system'
}) {
    const next = await createCredential({
        routerId: router?._id || null,
        scope: 'router_access',
        principal,
        secret,
        transportHint,
        apiPort,
        username: principal,
        createdBy,
        state: 'pending'
    });

    return next;
}

async function markCredentialVerified(routerId, credentialId) {
    const now = new Date();
    await RouterCredential.findByIdAndUpdate(credentialId, {
        state: 'active',
        verifiedAt: now
    }).catch(() => undefined);

    const router = await MikrotikRouter.findById(routerId).select('credentialState.secretRef');
    if (router?.credentialState?.secretRef && String(router.credentialState.secretRef) !== String(credentialId)) {
        await RouterCredential.findByIdAndUpdate(router.credentialState.secretRef, {
            state: 'superseded',
            rotatedAt: now
        }).catch(() => undefined);
    }

    await MikrotikRouter.findByIdAndUpdate(routerId, {
        'credentialState.secretRef': credentialId,
        'credentialState.state': 'active',
        'credentialState.lastVerifiedAt': now,
        'credentialState.lastRotatedAt': now,
        'credentialState.verificationFailureCount': 0
    }).catch(() => undefined);
}

module.exports = {
    DEFAULT_PORT_BY_TRANSPORT,
    encryptSecret,
    decryptSecret,
    createCredential,
    attachCredentialToRouter,
    getCredentialDocument,
    getResolvedCredential,
    rotateCredential,
    markCredentialVerified
};
