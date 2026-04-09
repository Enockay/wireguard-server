const crypto = require('crypto');

const TEST_JWT_FALLBACK = 'test-jwt-secret';

function getJwtSecret() {
    const configured = String(process.env.JWT_SECRET || '').trim();
    if (configured) {
        return configured;
    }

    if (process.env.NODE_ENV === 'test') {
        return TEST_JWT_FALLBACK;
    }

    return null;
}

function hasValidJwtSecret() {
    return Boolean(getJwtSecret());
}

function signJsonPayload(payload, secret) {
    return crypto
        .createHmac('sha256', String(secret || ''))
        .update(JSON.stringify(payload ?? {}))
        .digest('hex');
}

function timingSafeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyJsonWebhookSignature(req, secret, headerNames = ['x-webhook-signature']) {
    const normalizedSecret = String(secret || '').trim();
    if (!normalizedSecret) {
        return { ok: false, code: 'missing_secret' };
    }

    const expected = signJsonPayload(req.body || {}, normalizedSecret);
    const provided = headerNames
        .map((name) => req.get?.(name) || req.headers?.[String(name).toLowerCase()] || req.headers?.[name])
        .find(Boolean);

    if (!provided) {
        return { ok: false, code: 'missing_signature' };
    }

    if (!timingSafeEqual(String(provided).trim(), expected)) {
        return { ok: false, code: 'invalid_signature' };
    }

    return { ok: true };
}

module.exports = {
    TEST_JWT_FALLBACK,
    getJwtSecret,
    hasValidJwtSecret,
    signJsonPayload,
    verifyJsonWebhookSignature
};
