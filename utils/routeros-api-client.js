const net = require('net');

function encodeLength(length) {
    if (length < 0x80) return Buffer.from([length]);
    if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
    if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
    if (length < 0x10000000) return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
    return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function decodeLength(buffer, offset = 0) {
    const first = buffer[offset];
    if (first < 0x80) return { length: first, bytes: 1 };
    if ((first & 0xc0) === 0x80) return { length: ((first & ~0xc0) << 8) + buffer[offset + 1], bytes: 2 };
    if ((first & 0xe0) === 0xc0) return { length: ((first & ~0xe0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], bytes: 3 };
    if ((first & 0xf0) === 0xe0) return { length: ((first & ~0xf0) << 24) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3], bytes: 4 };
    return { length: (buffer[offset + 1] << 24) + (buffer[offset + 2] << 16) + (buffer[offset + 3] << 8) + buffer[offset + 4], bytes: 5 };
}

function sentenceToRecord(words) {
    const record = {};
    words.forEach((word) => {
        if (!word.startsWith('=')) return;
        const nextEquals = word.indexOf('=', 1);
        if (nextEquals === -1) return;
        const key = word.slice(1, nextEquals);
        const value = word.slice(nextEquals + 1);
        record[key] = value;
    });
    return record;
}

class RouterOsApiClient {
    constructor({ host, port = 8728, timeout = 5000 }) {
        this.host = host;
        this.port = port;
        this.timeout = timeout;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
    }

    async connect() {
        await new Promise((resolve, reject) => {
            const socket = new net.Socket();
            this.socket = socket;
            socket.setTimeout(this.timeout);
            socket.once('connect', resolve);
            socket.once('timeout', () => reject(new Error('RouterOS API timeout')));
            socket.once('error', reject);
            socket.connect(this.port, this.host);
        });
    }

    close() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    async waitForChunk() {
        return await new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('RouterOS API socket is not connected'));
                return;
            }

            const cleanup = () => {
                this.socket.off('data', handleData);
                this.socket.off('error', handleError);
                this.socket.off('timeout', handleTimeout);
                this.socket.off('close', handleClose);
            };
            const handleData = (chunk) => {
                cleanup();
                resolve(chunk);
            };
            const handleError = (error) => {
                cleanup();
                reject(error);
            };
            const handleTimeout = () => {
                cleanup();
                reject(new Error('RouterOS API timeout'));
            };
            const handleClose = () => {
                cleanup();
                reject(new Error('RouterOS API socket closed before response was received'));
            };

            this.socket.once('data', handleData);
            this.socket.once('error', handleError);
            this.socket.once('timeout', handleTimeout);
            this.socket.once('close', handleClose);
        });
    }

    async writeSentence(words) {
        const chunks = words.map((word) => {
            const payload = Buffer.from(String(word), 'utf8');
            return Buffer.concat([encodeLength(payload.length), payload]);
        });
        chunks.push(Buffer.from([0]));
        const payload = Buffer.concat(chunks);

        await new Promise((resolve, reject) => {
            this.socket.write(payload, (error) => error ? reject(error) : resolve());
        });
    }

    async readWord() {
        while (true) {
            if (this.buffer.length > 0) {
                const { length, bytes } = decodeLength(this.buffer, 0);
                if (this.buffer.length >= bytes + length) {
                    const word = this.buffer.slice(bytes, bytes + length).toString('utf8');
                    this.buffer = this.buffer.slice(bytes + length);
                    return word;
                }
            }

            const chunk = await this.waitForChunk();
            this.buffer = Buffer.concat([this.buffer, chunk]);
        }
    }

    async readSentence() {
        const words = [];
        while (true) {
            const word = await this.readWord();
            if (word === '') return words;
            words.push(word);
        }
    }

    async execute(command, attributes = {}) {
        const words = [command, ...Object.entries(attributes).map(([key, value]) => `=${key}=${value}`)];
        await this.writeSentence(words);
        const records = [];

        while (true) {
            const sentence = await this.readSentence();
            const [tag] = sentence;
            if (tag === '!re') {
                records.push(sentenceToRecord(sentence));
                continue;
            }
            if (tag === '!trap') {
                const details = sentenceToRecord(sentence);
                throw new Error(details.message || details.category || 'RouterOS API command failed');
            }
            if (tag === '!done') {
                return records;
            }
        }
    }

    async login(username, password) {
        await this.execute('/login', { name: username, password });
    }
}

async function executeRouterOsApiCommand({ host, port = 8728, username, password, command, attributes = {}, timeout = 5000 }) {
    const client = new RouterOsApiClient({ host, port, timeout });
    try {
        await client.connect();
        await client.login(username, password);
        const data = await client.execute(command, attributes);
        return { success: true, data };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            isAuthError: /invalid user name or password|not enough permissions|cannot log in/i.test(error.message)
        };
    } finally {
        client.close();
    }
}

module.exports = {
    RouterOsApiClient,
    executeRouterOsApiCommand
};
