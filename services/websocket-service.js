const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { log } = require('../wg-core');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const connections = new Map();
let webSocketServer = null;

function parseTokenFromUrl(url = '') {
    try {
        const parsed = new URL(url, 'http://localhost');
        return parsed.searchParams.get('token');
    } catch (error) {
        return null;
    }
}

function safeSend(ws, payload) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function createWebSocketServer(httpServer) {
    if (webSocketServer) {
        return webSocketServer;
    }

    webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });

    webSocketServer.on('connection', (ws, req) => {
        const token = parseTokenFromUrl(req.url || '');
        if (!token) {
            ws.close(4001, 'Authentication required');
            return;
        }

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            ws.close(4001, 'Invalid token');
            return;
        }

        const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const connection = {
            ws,
            userId: decoded.userId || decoded.id || null,
            rooms: new Set()
        };
        connections.set(clientId, connection);

        log('info', 'websocket_client_connected', {
            clientId,
            userId: connection.userId
        });

        ws.on('message', (rawMessage) => {
            try {
                const message = JSON.parse(String(rawMessage || '{}'));
                if (message.type === 'subscribe' && typeof message.room === 'string') {
                    connection.rooms.add(message.room);
                    safeSend(ws, { type: 'subscribed', room: message.room });
                    return;
                }
                if (message.type === 'unsubscribe' && typeof message.room === 'string') {
                    connection.rooms.delete(message.room);
                    safeSend(ws, { type: 'unsubscribed', room: message.room });
                    return;
                }
                if (message.type === 'ping') {
                    safeSend(ws, { type: 'pong' });
                }
            } catch (error) {
                safeSend(ws, { type: 'error', error: 'Invalid websocket message' });
            }
        });

        ws.on('close', () => {
            connections.delete(clientId);
            log('info', 'websocket_client_disconnected', { clientId, userId: connection.userId });
        });
    });

    log('info', 'websocket_server_started', { path: '/ws' });
    return webSocketServer;
}

function broadcastToRoom(room, data) {
    for (const [, connection] of connections) {
        if (connection.rooms.has(room)) {
            safeSend(connection.ws, data);
        }
    }
}

function broadcastRouterMetric(routerId, metric) {
    const payload = { type: 'router_metric', routerId: String(routerId), metric };
    broadcastToRoom(`router:${routerId}`, payload);
    broadcastToRoom('router:all', payload);
}

function broadcastRouterStatus(routerId, status) {
    const payload = { type: 'router_status', routerId: String(routerId), status };
    broadcastToRoom('router:all', payload);
    broadcastToRoom(`router:${routerId}`, payload);
}

module.exports = {
    createWebSocketServer,
    broadcastToRoom,
    broadcastRouterMetric,
    broadcastRouterStatus
};
