#!/usr/bin/env node
const http = require('http');
const { getLocalDiscoveryCidrs, scanSubnets, verifyRouterCandidate, verifyRouterCandidateApi } = require('../utils/router-discovery-core');

const port = Number(process.env.ROUTER_DISCOVERY_AGENT_PORT || 8787);
const token = String(process.env.ROUTER_DISCOVERY_AGENT_TOKEN || '').trim();

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
    if (!token) return true;
    const header = String(req.headers.authorization || '');
    return header === `Bearer ${token}`;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                resolve(body);
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

http.createServer(async (req, res) => {
    if (!isAuthorized(req)) {
        return sendJson(res, 401, { success: false, error: 'Unauthorized discovery agent request' });
    }

    if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
            success: true,
            status: 'ok',
            service: 'router-discovery-agent',
            subnets: getLocalDiscoveryCidrs(),
            timestamp: new Date().toISOString()
        });
    }

    if (req.method === 'GET' && req.url === '/capabilities') {
        return sendJson(res, 200, {
            success: true,
            service: 'router-discovery-agent',
            capabilities: {
                scan: true,
                verify: true,
                scanMode: 'tcp-probe',
                verificationMode: 'ssh',
                localSubnets: getLocalDiscoveryCidrs()
            }
        });
    }

    if (req.method === 'POST' && req.url === '/scan') {
        try {
            const body = await readBody(req);
            const subnets = Array.isArray(body.subnets) ? body.subnets : [];
            const result = await scanSubnets({ subnets, source: 'agent' });
            return sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    if (req.method === 'POST' && req.url === '/verify') {
        try {
            const body = await readBody(req);
            const method = String(body.method || 'auto').toLowerCase();
            const result = method === 'api'
                ? await verifyRouterCandidateApi(body)
                : method === 'ssh'
                    ? await verifyRouterCandidate(body)
                    : (Array.isArray(body.openPorts) && body.openPorts.includes(8728) ? await verifyRouterCandidateApi(body) : await verifyRouterCandidate(body));
            return sendJson(res, result.success ? 200 : 400, { success: result.success, verification: result.verification || null, error: result.error || null });
        } catch (error) {
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    return sendJson(res, 404, { success: false, error: 'Not found' });
}).listen(port, () => {
    process.stdout.write(`Router discovery agent listening on ${port}\n`);
});
