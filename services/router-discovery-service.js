const RouterDiscoverySession = require('../models/RouterDiscoverySession');
const MikrotikRouter = require('../models/MikrotikRouter');
const { createRouterAdmin } = require('./admin-router-service');
const {
    getLocalDiscoveryCidrs,
    parseCidr,
    scanSubnets,
    verifyRouterCandidate,
    verifyRouterCandidateApi
} = require('../utils/router-discovery-core');

function buildDiscoveryHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (process.env.ROUTER_DISCOVERY_AGENT_TOKEN) {
        headers.authorization = `Bearer ${process.env.ROUTER_DISCOVERY_AGENT_TOKEN}`;
    }
    return headers;
}

async function callDiscoveryAgent(path, payload) {
    const baseUrl = String(process.env.ROUTER_DISCOVERY_AGENT_URL || '').trim().replace(/\/$/, '');
    if (!baseUrl) {
        throw new Error('Discovery agent URL is not configured');
    }

    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: buildDiscoveryHeaders(),
        body: JSON.stringify(payload || {})
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        throw new Error(data.error || `Discovery agent request failed (${response.status})`);
    }

    return data;
}

function serializeCandidate(candidate) {
    return {
        id: String(candidate._id),
        ipAddress: candidate.ipAddress,
        subnet: candidate.subnet || null,
        hostname: candidate.hostname || null,
        macAddress: candidate.macAddress || null,
        vendor: candidate.vendor || null,
        openPorts: candidate.openPorts || [],
        detectedServices: candidate.detectedServices || [],
        isLikelyMikrotik: Boolean(candidate.isLikelyMikrotik),
        confidence: Number(candidate.confidence || 0),
        discoverySource: candidate.discoverySource || 'server',
        scannedAt: candidate.scannedAt,
        verification: candidate.verification ? {
            status: candidate.verification.status || 'unverified',
            method: candidate.verification.method || null,
            verifiedAt: candidate.verification.verifiedAt || null,
            expiresAt: candidate.verification.expiresAt || null,
            metadata: candidate.verification.metadata || null,
            readiness: candidate.verification.readiness ? {
                status: candidate.verification.readiness.status || 'warning',
                reasons: candidate.verification.readiness.reasons || [],
                apiReachable: Boolean(candidate.verification.readiness.apiReachable),
                sshReachable: Boolean(candidate.verification.readiness.sshReachable),
                winboxReachable: Boolean(candidate.verification.readiness.winboxReachable),
                wireGuardReady: Boolean(candidate.verification.readiness.wireGuardReady),
                duplicateRouterId: candidate.verification.readiness.duplicateRouterId ? String(candidate.verification.readiness.duplicateRouterId) : null
            } : null,
            error: candidate.verification.error || null
        } : null,
        importedRouterId: candidate.importedRouterId ? String(candidate.importedRouterId) : null,
        importedAt: candidate.importedAt || null
    };
}

function serializeSession(session) {
    return {
        id: String(session._id),
        source: session.source,
        status: session.status,
        requestedSubnet: session.requestedSubnet || null,
        scannedSubnets: session.scannedSubnets || [],
        reason: session.reason || '',
        hostCountScanned: Number(session.hostCountScanned || 0),
        candidateCount: Number(session.candidateCount || (session.candidates || []).length),
        truncatedReason: session.truncatedReason || null,
        error: session.error || null,
        truncated: Boolean(session.truncated),
        scanStartedAt: session.scanStartedAt,
        scanCompletedAt: session.scanCompletedAt || null,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        candidates: (session.candidates || []).map(serializeCandidate)
    };
}

function getRequestedSubnets(requestedSubnet) {
    const normalized = String(requestedSubnet || '').trim();
    if (normalized) {
        const parsed = parseCidr(normalized);
        if (!parsed) {
            throw new Error('Subnet must be a valid IPv4 CIDR, for example 192.168.88.0/24');
        }
        return [parsed.cidr];
    }

    const local = getLocalDiscoveryCidrs();
    if (!local.length) {
        throw new Error('No local IPv4 subnets were detected. Provide a subnet explicitly or configure ROUTER_DISCOVERY_AGENT_URL.');
    }
    return local;
}

async function executeDiscoveryScan(sessionId) {
    const session = await RouterDiscoverySession.findById(sessionId);
    if (!session) return;

    try {
        session.status = 'scanning';
        await session.save();

        const targetSubnets = getRequestedSubnets(session.requestedSubnet);
        let scanResult;

        if (process.env.ROUTER_DISCOVERY_AGENT_URL) {
            const agentResponse = await callDiscoveryAgent('/scan', { subnets: targetSubnets });
            scanResult = {
                scannedSubnets: agentResponse.scannedSubnets || targetSubnets,
                hostCountScanned: Number(agentResponse.hostCountScanned || 0),
                truncated: Boolean(agentResponse.truncated),
                truncatedReason: agentResponse.truncatedReason || null,
                candidates: agentResponse.candidates || []
            };
            session.source = 'agent';
        } else {
            scanResult = await scanSubnets({ subnets: targetSubnets, source: 'server' });
            session.source = 'server';
        }

        session.scannedSubnets = scanResult.scannedSubnets;
        session.hostCountScanned = Number(scanResult.hostCountScanned || 0);
        session.candidateCount = Array.isArray(scanResult.candidates) ? scanResult.candidates.length : 0;
        session.truncated = Boolean(scanResult.truncated);
        session.truncatedReason = scanResult.truncatedReason || null;
        session.candidates = scanResult.candidates;
        session.status = 'completed';
        session.scanCompletedAt = new Date();
        session.error = null;
        await session.save();
    } catch (error) {
        session.status = 'failed';
        session.error = error.message;
        session.scanCompletedAt = new Date();
        await session.save();
    }
}

async function startDiscoveryScan({ adminUserId, requestedSubnet, reason = '' }) {
    const session = await RouterDiscoverySession.create({
        adminUserId,
        requestedSubnet: requestedSubnet || null,
        reason: String(reason || '').trim(),
        status: 'pending'
    });

    void executeDiscoveryScan(session._id);
    return serializeSession(session);
}

async function listDiscoveryResults({ sessionId } = {}) {
    if (sessionId) {
        const session = await RouterDiscoverySession.findById(sessionId).sort({ createdAt: -1 });
        return session ? [serializeSession(session)] : [];
    }

    const sessions = await RouterDiscoverySession.find({})
        .sort({ createdAt: -1 })
        .limit(10);

    return sessions.map(serializeSession);
}

async function findDuplicateRouter(metadata, candidate) {
    const duplicateQuery = [];
    if (metadata?.serialNumber) {
        duplicateQuery.push({ 'routerboardInfo.serialNumber': metadata.serialNumber });
    }
    if (candidate?.ipAddress) {
        duplicateQuery.push({ 'discoveryInfo.localAddress': candidate.ipAddress });
    }

    if (!duplicateQuery.length) return null;
    return MikrotikRouter.findOne({ $or: duplicateQuery }).lean();
}

async function verifyDiscoveryCandidate({ sessionId, candidateId, username, password, method = 'auto' }) {
    const session = await RouterDiscoverySession.findById(sessionId);
    if (!session) throw new Error('Discovery session not found');

    const candidate = session.candidates.id(candidateId);
    if (!candidate) throw new Error('Discovery candidate not found');
    if (candidate.importedRouterId) throw new Error('This discovered router has already been imported');

    const verificationMethod = String(method || 'auto').toLowerCase();
    let result;
    if (process.env.ROUTER_DISCOVERY_AGENT_URL) {
        const agentResponse = await callDiscoveryAgent('/verify', {
            ipAddress: candidate.ipAddress,
            username,
            password,
            openPorts: candidate.openPorts,
            method: verificationMethod
        });
        result = {
            success: Boolean(agentResponse.success),
            verification: agentResponse.verification || null,
            error: agentResponse.error || null
        };
    } else {
        if (verificationMethod === 'api') {
            result = await verifyRouterCandidateApi({
                ipAddress: candidate.ipAddress,
                username,
                password,
                openPorts: candidate.openPorts
            });
        } else if (verificationMethod === 'ssh') {
            result = await verifyRouterCandidate({
                ipAddress: candidate.ipAddress,
                username,
                password,
                openPorts: candidate.openPorts
            });
        } else {
            result = candidate.openPorts.includes(8728)
                ? await verifyRouterCandidateApi({
                    ipAddress: candidate.ipAddress,
                    username,
                    password,
                    openPorts: candidate.openPorts
                })
                : await verifyRouterCandidate({
                    ipAddress: candidate.ipAddress,
                    username,
                    password,
                    openPorts: candidate.openPorts
                });
        }
    }

    const duplicateRouter = result.success ? await findDuplicateRouter(result.verification?.metadata, candidate) : null;
    const verification = result.verification || {
        status: 'failed',
        method: 'ssh',
        metadata: null,
        readiness: {
            status: 'blocked',
            reasons: [result.error || 'Verification failed'],
            apiReachable: candidate.openPorts.includes(8728) || candidate.openPorts.includes(8729),
            sshReachable: candidate.openPorts.includes(22),
            winboxReachable: candidate.openPorts.includes(8291),
            wireGuardReady: false
        }
    };

    if (duplicateRouter) {
        verification.status = 'duplicate';
        verification.readiness = {
            ...(verification.readiness || {}),
            status: 'blocked',
            reasons: [...new Set([...(verification.readiness?.reasons || []), 'Router appears to already be onboarded'])],
            duplicateRouterId: duplicateRouter._id
        };
    }

    candidate.verification = {
        status: verification.status || (result.success ? 'verified' : 'failed'),
        method: verification.method || 'ssh',
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        metadata: verification.metadata || null,
        readiness: verification.readiness || null,
        error: result.error || verification.error || null
    };

    await session.save();
    return {
        session: serializeSession(session),
        candidate: serializeCandidate(candidate)
    };
}

async function importDiscoveryCandidate({ sessionId, candidateId, userId, name, serverNode = 'wireguard', reason = '' }) {
    const session = await RouterDiscoverySession.findById(sessionId);
    if (!session) throw new Error('Discovery session not found');

    const candidate = session.candidates.id(candidateId);
    if (!candidate) throw new Error('Discovery candidate not found');
    if (candidate.importedRouterId) throw new Error('This discovered router has already been imported');
    if (!candidate.verification || !['verified', 'duplicate'].includes(candidate.verification.status)) {
        throw new Error('Verify the router before importing it');
    }
    if (!candidate.verification.expiresAt || new Date(candidate.verification.expiresAt).getTime() < Date.now()) {
        throw new Error('Verification has expired. Re-verify the router before importing it');
    }
    if (candidate.verification.readiness?.duplicateRouterId) {
        throw new Error('This router appears to already be onboarded');
    }

    const metadata = candidate.verification.metadata || {};
    const routerName = String(name || metadata.identity || candidate.hostname || `router-${candidate.ipAddress.replace(/\./g, '-')}`).trim();
    const created = await createRouterAdmin({
        userId,
        name: routerName,
        serverNode,
        notes: `Imported from discovery session ${String(session._id)}`
    });

    created.router.routerboardInfo = {
        ...(created.router.routerboardInfo || {}),
        boardName: metadata.boardName || created.router.routerboardInfo?.boardName,
        model: metadata.model || metadata.identity || created.router.routerboardInfo?.model,
        serialNumber: metadata.serialNumber || created.router.routerboardInfo?.serialNumber,
        firmware: metadata.routerosVersion || metadata.firmware || created.router.routerboardInfo?.firmware,
        lastChecked: new Date()
    };
    created.router.discoveryInfo = {
        localAddress: candidate.ipAddress,
        subnet: candidate.subnet || null,
        hostname: candidate.hostname || metadata.identity || null,
        macAddress: candidate.macAddress || metadata.macAddress || null,
        source: session.source,
        discoverySessionId: session._id,
        importedAt: new Date(),
        importedBy: String(session.adminUserId),
        openPorts: candidate.openPorts || []
    };
    created.router.adminNotes.push({
        body: `Imported from discovery. Local IP: ${candidate.ipAddress}${metadata.identity ? ` · Identity: ${metadata.identity}` : ''}${reason ? ` · ${reason}` : ''}`,
        category: 'provisioning',
        pinned: true,
        author: 'system'
    });
    await created.router.save();

    candidate.importedRouterId = created.router._id;
    candidate.importedAt = new Date();
    candidate.verification.status = 'imported';
    await session.save();

    return {
        router: {
            id: String(created.router._id),
            name: created.router.name,
            vpnIp: created.router.vpnIp,
            ports: created.router.ports,
            status: created.router.status
        },
        session: serializeSession(session),
        candidate: serializeCandidate(candidate)
    };
}

module.exports = {
    startDiscoveryScan,
    listDiscoveryResults,
    verifyDiscoveryCandidate,
    importDiscoveryCandidate,
    serializeSession
};
