const crypto = require('crypto');

const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            output += TOTP_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += TOTP_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
}

function base32Decode(input) {
    const normalized = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];

    for (const character of normalized) {
        const index = TOTP_ALPHABET.indexOf(character);
        if (index === -1) continue;
        value = (value << 5) | index;
        bits += 5;

        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}

function generateTotpSecret(length = 20) {
    return base32Encode(crypto.randomBytes(length));
}

function normalizeSecret(secret) {
    return String(secret || '').replace(/\s+/g, '').toUpperCase();
}

function generateTotpCode(secret, timestamp = Date.now()) {
    const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const key = base32Decode(normalizeSecret(secret));
    const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

    return String(binary % (10 ** DIGITS)).padStart(DIGITS, '0');
}

function verifyTotpCode(secret, code, { window = 1, timestamp = Date.now() } = {}) {
    const normalizedCode = String(code || '').trim();
    if (!/^\d{6}$/.test(normalizedCode)) return false;

    for (let offset = -window; offset <= window; offset += 1) {
        const candidate = generateTotpCode(secret, timestamp + offset * STEP_SECONDS * 1000);
        if (candidate === normalizedCode) {
            return true;
        }
    }

    return false;
}

function buildOtpAuthUri({ secret, label, issuer = 'Mikrotik Admin' }) {
    const normalizedLabel = encodeURIComponent(label);
    const normalizedIssuer = encodeURIComponent(issuer);
    return `otpauth://totp/${normalizedLabel}?secret=${encodeURIComponent(normalizeSecret(secret))}&issuer=${normalizedIssuer}`;
}

module.exports = {
    buildOtpAuthUri,
    generateTotpCode,
    generateTotpSecret,
    verifyTotpCode,
};
