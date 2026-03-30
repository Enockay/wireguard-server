const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT, withMockedModules } = require('./helpers/test-kit');

const serviceModulePath = path.join(ROOT, 'services/router-execution-service.js');

test('classifyFailure treats no-route errors as endpoint_unreachable instead of auth_failed', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterConfigSnapshot.js': {},
        'utils/routeros-api-client.js': {},
        'services/mikrotik-api-service.js': {},
        'services/router-credential-service.js': {},
        'services/operation-policy-service.js': {},
        'services/operation-ledger-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { classifyFailure } = require(serviceModulePath);

        const failureType = classifyFailure(new Error(
            'Command failed: ssh -o PasswordAuthentication=yes admin@10.0.0.11 "/system/resource/print"\nssh: connect to host 10.0.0.11 port 22: No route to host'
        ));

        assert.equal(failureType, 'endpoint_unreachable');

        delete require.cache[serviceModulePath];
    });
});

test('classifyFailure treats ssh permission denied as auth_failed even when command contains ConnectTimeout option', async () => {
    const mocks = {
        'models/MikrotikRouter.js': {},
        'models/RouterConfigSnapshot.js': {},
        'utils/routeros-api-client.js': {},
        'services/mikrotik-api-service.js': {},
        'services/router-credential-service.js': {},
        'services/operation-policy-service.js': {},
        'services/operation-ledger-service.js': {},
        'wg-core.js': { log() {} }
    };

    await withMockedModules(mocks, async () => {
        delete require.cache[serviceModulePath];
        const { classifyFailure } = require(serviceModulePath);

        const failureType = classifyFailure(new Error(
            'Command failed: ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no -o BatchMode=yes admin@167.86.73.169 "/interface/print"\nadmin@167.86.73.169: Permission denied (publickey,password).'
        ));

        assert.equal(failureType, 'auth_failed');

        delete require.cache[serviceModulePath];
    });
});
