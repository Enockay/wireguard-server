const { Client } = require('ssh2');
const { log } = require('../wg-core');
const { execute: executeRouterOperation } = require('./router-execution-service');

const TERMINAL_READY_TIMEOUT_MS = 10000;
const TERMINAL_KEEPALIVE_INTERVAL_MS = 30000;
const TERMINAL_KEEPALIVE_COUNT_MAX = 6;

function safeSend(ws, payload) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function startSshSession(ws, routerId, credentials) {
    const { host, port = 22, username = 'admin', password = '', onFallback = null } = credentials || {};
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
        safeSend(ws, {
            type: 'status',
            state: 'connected',
            mode: 'ssh',
            endpoint: {
                host,
                port,
                transport: 'ssh',
                pathType: credentials?.pathType || 'unknown'
            }
        });
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
        if (!streamRef && typeof onFallback === 'function') {
            safeSend(ws, { type: 'status', state: 'fallback', mode: 'api_console', message: 'SSH unreachable, switching to API console.' });
            try {
                onFallback();
                closed = true;
                try {
                    client.end();
                } catch (closeError) {
                    log('warn', 'router_terminal_client_close_failed', { routerId, error: closeError.message });
                }
                return;
            } catch (fallbackError) {
                safeSend(ws, { type: 'error', message: fallbackError.message || 'API console fallback failed' });
            }
        }
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

function formatApiConsoleOutput(result) {
    if (Array.isArray(result?.data)) {
        return result.data.map((record) => (
            Object.entries(record || {})
                .map(([key, value]) => `${key}: ${value == null ? '' : value}`)
                .join('\n')
        )).join('\n\n');
    }

    if (typeof result?.data === 'string') {
        return result.data;
    }

    if (Array.isArray(result?.records)) {
        return result.records.map((record) => JSON.stringify(record)).join('\n');
    }

    if (result?.data && typeof result.data === 'object') {
        return JSON.stringify(result.data, null, 2);
    }

    return '';
}

function startApiConsoleSession(ws, routerId, options = {}) {
    const actor = options.actor || 'terminal';
    const actorType = options.actorType || 'admin';
    const prompt = options.prompt || 'router> ';
    let closed = false;
    let inputBuffer = '';

    const cleanup = (reason = 'closed') => {
        if (closed) return;
        closed = true;
        safeSend(ws, { type: 'closed', reason });
    };

    const writePrompt = () => {
        safeSend(ws, { type: 'output', data: prompt });
    };

    const runCommand = async (command) => {
        const trimmed = String(command || '').trim();
        if (!trimmed) {
            writePrompt();
            return;
        }

        if (trimmed === 'exit' || trimmed === 'quit') {
            safeSend(ws, { type: 'output', data: '\r\n[session closed]\r\n' });
            cleanup('api_console_exit');
            return;
        }

        if (trimmed === 'help') {
            safeSend(ws, {
                type: 'output',
                data: '\r\nAPI console mode: enter RouterOS commands one line at a time. Use "quit" to close.\r\n'
            });
            writePrompt();
            return;
        }

        try {
            const result = await executeRouterOperation(
                routerId,
                'raw_command',
                {
                    command: trimmed,
                    metadata: {
                        source: 'web_terminal_api_console'
                    }
                },
                { actor, actorType }
            );
            const output = formatApiConsoleOutput(result);
            safeSend(ws, { type: 'output', data: `\r\n${output ? `${output}\r\n` : ''}` });
        } catch (error) {
            safeSend(ws, { type: 'output', data: `\r\n[error] ${error.message || 'Command failed'}\r\n` });
        }
        writePrompt();
    };

    safeSend(ws, {
        type: 'status',
        state: 'connected',
        mode: 'api_console',
        endpoint: {
            host: options.host || null,
            port: options.port || null,
            transport: options.transport || 'api',
            pathType: options.pathType || 'unknown'
        }
    });
    safeSend(ws, { type: 'output', data: 'Connected in API console mode.\r\n' });
    writePrompt();

    ws.on('message', (message) => {
        if (closed) return;
        try {
            const parsed = JSON.parse(String(message || '{}'));
            if (parsed.type !== 'input' || typeof parsed.data !== 'string') {
                return;
            }

            for (const character of parsed.data) {
                if (character === '\r' || character === '\n') {
                    const command = inputBuffer;
                    inputBuffer = '';
                    safeSend(ws, { type: 'output', data: '\r\n' });
                    void runCommand(command);
                    continue;
                }

                if (character === '\u007f') {
                    if (inputBuffer.length > 0) {
                        inputBuffer = inputBuffer.slice(0, -1);
                        safeSend(ws, { type: 'output', data: '\b \b' });
                    }
                    continue;
                }

                inputBuffer += character;
                safeSend(ws, { type: 'output', data: character });
            }
        } catch (error) {
            safeSend(ws, { type: 'error', message: 'Invalid terminal message' });
        }
    });

    ws.on('close', () => {
        cleanup('websocket_closed');
    });
}

module.exports = {
    startSshSession,
    startApiConsoleSession
};
