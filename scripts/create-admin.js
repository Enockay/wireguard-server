// One-off / repeatable CLI utility to bootstrap an admin account.
// Usage: node scripts/create-admin.js <email> [name] [password]
// If password is omitted, a strong random one is generated and printed once.
require('dotenv').config();
const crypto = require('crypto');
const db = require('../db');
const User = require('../models/User');

function generatePassword(length = 20) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    return Array.from(crypto.randomFillSync(new Uint32Array(length)))
        .map(n => chars[n % chars.length])
        .join('');
}

async function main() {
    const [, , email, name, providedPassword] = process.argv;

    if (!email) {
        console.error('Usage: node scripts/create-admin.js <email> [name] [password]');
        process.exit(1);
    }

    const normalizedEmail = email.toLowerCase().trim();
    const password = providedPassword || generatePassword();

    await db.connect();

    try {
        const existing = await User.findOne({ email: normalizedEmail });
        if (existing) {
            console.error(`A user with email "${normalizedEmail}" already exists (role: ${existing.role}). Refusing to overwrite.`);
            process.exit(1);
        }

        const referralCode = crypto.randomBytes(8).toString('hex').toUpperCase();

        const admin = new User({
            email: normalizedEmail,
            password,
            name: name || 'Admin',
            role: 'admin',
            emailVerified: true,
            isActive: true,
            referralCode
        });

        await admin.save();

        console.log('Admin account created:');
        console.log(`  Email:    ${normalizedEmail}`);
        console.log(`  Password: ${password}`);
        console.log('Store this password now - it is not saved anywhere in plaintext.');
    } finally {
        await db.disconnect();
    }
}

main().catch(err => {
    console.error('Failed to create admin:', err.message);
    process.exit(1);
});
