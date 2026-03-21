const test = require('node:test');
const assert = require('node:assert/strict');

const {
    encryptSecret,
    decryptSecret
} = require('../services/router-credential-service');
const {
    authorizeOperation,
    classifyRawCommand
} = require('../services/operation-policy-service');

test('router credential service encrypts and decrypts secrets', async () => {
    const encrypted = encryptSecret('Password123!');
    assert.ok(encrypted.secretCiphertext);
    assert.equal(decryptSecret(encrypted), 'Password123!');
});

test('operation policy blocks management-only network-core mutations', async () => {
    const router = {
        connectionMode: 'management_only',
        managementMode: 'management_only',
        capabilities: {
            rawRead: true,
            rawWrite: true
        },
        safetyPolicy: {
            defaultMaxClass: 'safe_operational',
            allowNetworkCoreWrites: false,
            approvedScopes: []
        }
    };

    const decision = authorizeOperation(router, 'raw_command', {
        command: '/ip route add dst-address=0.0.0.0/0 gateway=ether1',
        breakGlass: true
    });

    assert.equal(classifyRawCommand('/ip route add dst-address=0.0.0.0/0 gateway=ether1'), 'network_core_mutation');
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unsafe_operation_blocked');
    assert.equal(decision.details.managementMode, 'management_only');
    assert.equal(decision.details.capabilityRequired, 'rawWrite');
});

test('operation policy allows read-only raw commands without break-glass', async () => {
    const router = {
        managementMode: 'management_only',
        capabilities: {
            rawRead: true
        },
        safetyPolicy: {
            defaultMaxClass: 'safe_operational',
            allowNetworkCoreWrites: false,
            approvedScopes: []
        }
    };

    const decision = authorizeOperation(router, 'raw_command', {
        command: '/system resource print'
    });

    assert.equal(decision.allowed, true);
});
