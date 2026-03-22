const { Client } = require('ssh2');
const { log } = require('../wg-core');

function safeSend(ws, payload) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function startSshSession(ws, routerId, credentials) {
    const { host, username = 'admin', password = '' } = credentials || {};
    const client = new Client();

    client.on('ready', () => {
        log('info', 'router_terminal_ready', { routerId, host, username });
        safeSend(ws, { type: 'status', state: 'connected' });

        client.shell((error, stream) => {
            if (error) {
                safeSend(ws, { type: 'error', message: error.message || 'Failed to open SSH shell' });
                client.end();
                return;
            }

            stream.on('data', (data) => {
                safeSend(ws, { type: 'output', data: data.toString() });
            });

            if (stream.stderr) {
                stream.stderr.on('data', (data) => {
                    safeSend(ws, { type: 'output', data: data.toString() });
                });
            }

            ws.on('message', (message) => {
                try {
                    const parsed = JSON.parse(String(message || '{}'));
                    if (parsed.type === 'input' && typeof parsed.data === 'string') {
                        stream.write(parsed.data);
                    }
                    if (parsed.type === 'resize' && Number.isFinite(parsed.rows) && Number.isFinite(parsed.cols)) {
                        stream.setWindow(parsed.rows, parsed.cols, 0, 0);
                    }
                } catch (parseError) {
                    safeSend(ws, { type: 'error', message: 'Invalid terminal message' });
                }
            });

            stream.on('close', () => {
                client.end();
                safeSend(ws, { type: 'closed' });
            });

            ws.on('close', () => {
                try {
                    stream.end();
                } catch (error) {
                    log('warn', 'router_terminal_stream_close_failed', { routerId, error: error.message });
                }
                client.end();
            });
        });
    });

    client.on('error', (error) => {
        log('warn', 'router_terminal_error', { routerId, host, error: error.message });
        safeSend(ws, { type: 'error', message: error.message || 'SSH connection failed' });
    });

    client.connect({
        host,
        port: 22,
        username,
        password,
        readyTimeout: 5000
    });

    return client;
}

module.exports = {
    startSshSession
};
