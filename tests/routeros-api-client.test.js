const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { RouterOsApiClient } = require('../utils/routeros-api-client');

class FakeSocket extends EventEmitter {}

function encodeWord(word) {
    const payload = Buffer.from(word, 'utf8');
    return Buffer.concat([Buffer.from([payload.length]), payload]);
}

test('RouterOsApiClient readWord cleans up socket listeners after successful reads', async () => {
    const client = new RouterOsApiClient({ host: '127.0.0.1' });
    const socket = new FakeSocket();
    client.socket = socket;

    for (let index = 0; index < 20; index += 1) {
        const readPromise = client.readWord();
        process.nextTick(() => {
            socket.emit('data', encodeWord(`word-${index}`));
        });

        await assert.doesNotReject(readPromise);
        assert.equal(await readPromise, `word-${index}`);
        assert.equal(socket.listenerCount('data'), 0);
        assert.equal(socket.listenerCount('error'), 0);
        assert.equal(socket.listenerCount('timeout'), 0);
        assert.equal(socket.listenerCount('close'), 0);
    }
});
