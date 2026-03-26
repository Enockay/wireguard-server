const { Client } = require('ssh2');
const { log } = require('../wg-core');

const TERMINAL_READY_TIMEOUT_MS = 10000;
const TERMINAL_KEEPALIVE_INTERVAL_MS = 30000;
const TERMINAL_KEEPALIVE_COUNT_MAX = 6;

function safeSend(ws, payload) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function startSshSession(ws, routerId, credentials) {
    const { host, port = 22, username = 'admin', password = '' } = credentials || {};
    const client = new Client();
    const sessionTimeoutMs = 30 * 60 * 1000;
    let streamRef = null;
    let closed = false;
    let sessionTimer = null;

    const cleanup = (reason = 'closed') => {
        if (closed) return;
        closed = true;
        if (sessionTimer) {
            clearTimeout(sessionTimer);
            sessionTimer = null;
        }
        if (streamRef) {
            try {
                streamRef.end();
            } catch (error) {
                log('warn', 'router_terminal_stream_close_failed', { routerId, error: error.message });
            }
            streamRef = null;
        }
        try {
            client.end();
        } catch (error) {
            log('warn', 'router_terminal_client_close_failed', { routerId, error: error.message });
        }
        safeSend(ws, { type: 'closed', reason });
    };

    client.on('ready', () => {
        log('info', 'router_terminal_ready', { routerId, host, username });
        safeSend(ws, { type: 'status', state: 'connected' });
        sessionTimer = setTimeout(() => {
            log('info', 'router_terminal_session_expired', { routerId, host, username });
            cleanup('session_timeout');
        }, sessionTimeoutMs);

        client.shell((error, stream) => {
            if (error) {
                safeSend(ws, { type: 'error', message: error.message || 'Failed to open SSH shell' });
                cleanup('shell_error');
                return;
            }
            streamRef = stream;

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
                cleanup('stream_closed');
            });

            ws.on('close', () => {
                cleanup('websocket_closed');
            });
        });
    });

    client.on('error', (error) => {
        log('warn', 'router_terminal_error', { routerId, host, port, error: error.message });
        safeSend(ws, { type: 'error', message: error.message || 'SSH connection failed' });
        cleanup('client_error');
    });

    client.connect({
        host,
        port,
        username,
        password,
        readyTimeout: TERMINAL_READY_TIMEOUT_MS,
        keepaliveInterval: TERMINAL_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: TERMINAL_KEEPALIVE_COUNT_MAX
    });

    return client;
}

module.exports = {
    startSshSession
};
