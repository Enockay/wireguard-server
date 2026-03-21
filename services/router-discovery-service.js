const RouterDiscoverySession = require('../models/RouterDiscoverySession');
const MikrotikRouter = require('../models/MikrotikRouter');
const { createRouterAdmin, createManagementOnlyRouterAdmin, generateRouterSetupArtifacts } = require('./admin-router-service');
const {
    getLocalDiscoveryCidrs,
    parseCidr,
    scanSubnets,
    verifyRouterCandidate,
    verifyRouterCandidateApi
} = require('../utils/router-discovery-core');
const { createCredential, attachCredentialToRouter } = require('./router-credential-service');
const { probeCapabilities } = require('./capability-probe-service');
const { execute: executeRouterOperation } = require('./router-execution-service');

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

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes';
}

function normalizeInterfaceEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        name: entry.name ? String(entry.name).trim() : 'unknown',
        type: entry.type ? String(entry.type).trim() : 'unknown',
        running: toBoolean(entry.running),
        disabled: toBoolean(entry.disabled),
        comment: entry.comment ? String(entry.comment).trim() : ''
    };
}

function parseInterfaceString(value) {
    const text = String(value || '').trim();
    if (!text) return [];

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map(normalizeInterfaceEntry).filter(Boolean);
        }
    } catch (error) {
        // Fall back to parsing util.inspect-style output.
    }

    const matches = [...text.matchAll(/\{\s*name:\s*'([^']*)',\s*type:\s*'([^']*)',\s*running:\s*(true|false),\s*disabled:\s*(true|false),\s*comment:\s*'([^']*)'\s*\}/g)];
    return matches.map((match) => ({
        name: match[1] || 'unknown',
        type: match[2] || 'unknown',
        running: match[3] === 'true',
        disabled: match[4] === 'true',
        comment: match[5] || ''
    }));
}

function normalizeVerificationMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }

    let interfaces = [];
    if (Array.isArray(metadata.interfaces)) {
        interfaces = metadata.interfaces.map(normalizeInterfaceEntry).filter(Boolean);
    } else if (typeof metadata.interfaces === 'string') {
        interfaces = parseInterfaceString(metadata.interfaces);
    } else if (metadata.interfaces && typeof metadata.interfaces === 'object') {
        interfaces = [normalizeInterfaceEntry(metadata.interfaces)].filter(Boolean);
    }

    return {
        identity: metadata.identity ? String(metadata.identity).trim() : null,
        boardName: metadata.boardName ? String(metadata.boardName).trim() : null,
        serialNumber: metadata.serialNumber ? String(metadata.serialNumber).trim() : null,
        routerosVersion: metadata.routerosVersion ? String(metadata.routerosVersion).trim() : null,
        firmware: metadata.firmware ? String(metadata.firmware).trim() : null,
        model: metadata.model ? String(metadata.model).trim() : null,
        macAddress: metadata.macAddress ? String(metadata.macAddress).trim() : null,
        interfaces,
        interfaceCount: Number(metadata.interfaceCount || interfaces.length || 0),
        raw: metadata.raw || null
    };
}

function normalizeVerificationPayload(verification, fallbackError = null) {
    const normalized = verification || {};
    return {
        status: normalized.status || 'failed',
        method: normalized.method || 'ssh',
        credentials: normalized.credentials ? {
            username: normalized.credentials.username ? String(normalized.credentials.username).trim() : null,
            credentialSecretRef: normalized.credentials.credentialSecretRef || null,
            apiPort: normalized.credentials.apiPort ? Number(normalized.credentials.apiPort) : null
        } : null,
        metadata: normalizeVerificationMetadata(normalized.metadata),
        readiness: normalized.readiness ? {
            status: normalized.readiness.status || 'warning',
            reasons: Array.isArray(normalized.readiness.reasons)
                ? normalized.readiness.reasons.map((reason) => String(reason))
                : [],
            apiReachable: Boolean(normalized.readiness.apiReachable),
            sshReachable: Boolean(normalized.readiness.sshReachable),
            winboxReachable: Boolean(normalized.readiness.winboxReachable),
            wireGuardReady: Boolean(normalized.readiness.wireGuardReady),
            duplicateRouterId: normalized.readiness.duplicateRouterId || null
        } : null,
        error: normalized.error || fallbackError || null
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

async function clearStaleCandidateRouterRefs(candidate) {
    let changed = false;

    if (candidate.importedRouterId) {
        const importedRouterExists = await MikrotikRouter.exists({ _id: candidate.importedRouterId });
        if (!importedRouterExists) {
            candidate.importedRouterId = null;
            candidate.importedAt = null;
            changed = true;
        }
    }

    const duplicateRouterId = candidate.verification?.readiness?.duplicateRouterId;
    if (duplicateRouterId) {
        const duplicateRouterExists = await MikrotikRouter.exists({ _id: duplicateRouterId });
        if (!duplicateRouterExists) {
            candidate.verification.readiness.duplicateRouterId = null;
            candidate.verification.readiness.reasons = (candidate.verification.readiness.reasons || [])
                .filter((reason) => reason !== 'Router appears to already be onboarded');
            if (candidate.verification.status === 'duplicate') {
                candidate.verification.status = 'verified';
            }
            changed = true;
        }
    }

    return changed;
}

async function verifyDiscoveryCandidate({ sessionId, candidateId, username, password, method = 'auto' }) {
    const session = await RouterDiscoverySession.findById(sessionId);
    if (!session) throw new Error('Discovery session not found');

    const candidate = session.candidates.id(candidateId);
    if (!candidate) throw new Error('Discovery candidate not found');
    const cleanedRefs = await clearStaleCandidateRouterRefs(candidate);
    if (cleanedRefs) {
        await session.save();
    }
    if (candidate.importedRouterId) throw new Error('This discovered router has already been imported');

    const verificationMethod = String(method || 'auto').toLowerCase();
    const preferredApiPort = candidate.openPorts.includes(8728)
        ? 8728
        : candidate.openPorts.includes(8729)
            ? 8729
            : 8728;
    let result;
    if (process.env.ROUTER_DISCOVERY_AGENT_URL) {
        const agentResponse = await callDiscoveryAgent('/verify', {
            ipAddress: candidate.ipAddress,
            username,
            password,
            openPorts: candidate.openPorts,
            method: verificationMethod,
            port: preferredApiPort
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
                openPorts: candidate.openPorts,
                port: preferredApiPort
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
                    openPorts: candidate.openPorts,
                    port: preferredApiPort
                })
                : await verifyRouterCandidate({
                    ipAddress: candidate.ipAddress,
                    username,
                    password,
                    openPorts: candidate.openPorts
                });
        }
    }

    const normalizedResultVerification = normalizeVerificationPayload(result.verification, result.error);
    const duplicateRouter = result.success ? await findDuplicateRouter(normalizedResultVerification?.metadata, candidate) : null;
    const verification = normalizedResultVerification.status ? normalizedResultVerification : normalizeVerificationPayload({
        status: 'failed',
        method: 'ssh',
        credentials: null,
        metadata: null,
        readiness: {
            status: 'blocked',
            reasons: [result.error || 'Verification failed'],
            apiReachable: candidate.openPorts.includes(8728) || candidate.openPorts.includes(8729),
            sshReachable: candidate.openPorts.includes(22),
            winboxReachable: candidate.openPorts.includes(8291),
            wireGuardReady: false
        }
    }, result.error);

    if (duplicateRouter) {
        verification.status = 'duplicate';
        verification.readiness = {
            ...(verification.readiness || {}),
            status: 'blocked',
            reasons: [...new Set([...(verification.readiness?.reasons || []), 'Router appears to already be onboarded'])],
            duplicateRouterId: duplicateRouter._id
        };
    }

    const normalizedUsername = String(username || '').trim() || null;
    const resolvedApiPort = verification.method === 'api' ? preferredApiPort : 8728;
    const credentialSecret = result.success
        ? await createCredential({
            scope: 'discovery_verification',
            principal: normalizedUsername,
            secret: String(password),
            transportHint: verification.method === 'api' ? 'api' : 'ssh',
            apiPort: resolvedApiPort,
            username: normalizedUsername,
            createdBy: String(session.adminUserId)
        })
        : null;

    candidate.verification = {
        status: verification.status || (result.success ? 'verified' : 'failed'),
        method: verification.method || 'ssh',
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        credentials: result.success ? {
            username: normalizedUsername,
            credentialSecretRef: credentialSecret?._id || null,
            apiPort: resolvedApiPort
        } : null,
        metadata: normalizeVerificationMetadata(verification.metadata) || null,
        readiness: verification.readiness || null,
        error: result.error || verification.error || null
    };

    await session.save();
    return {
        session: serializeSession(session),
        candidate: serializeCandidate(candidate)
    };
}

async function importDiscoveryCandidate({ sessionId, candidateId, userId, name, serverNode = 'wireguard', reason = '', connectionMode = 'wireguard' }) {
    const session = await RouterDiscoverySession.findById(sessionId);
    if (!session) throw new Error('Discovery session not found');

    const candidate = session.candidates.id(candidateId);
    if (!candidate) throw new Error('Discovery candidate not found');
    const cleanedRefs = await clearStaleCandidateRouterRefs(candidate);
    if (cleanedRefs) {
        await session.save();
    }
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
    const importMode = String(connectionMode || 'wireguard').trim().toLowerCase() === 'management_only' ? 'management_only' : 'wireguard';
    const created = importMode === 'management_only'
        ? await createManagementOnlyRouterAdmin({
            userId,
            name: routerName,
            notes: `Management-only import from discovery session ${String(session._id)}`
        })
        : await createRouterAdmin({
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
    if (candidate.verification?.credentials?.username) {
        created.router.apiUsername = candidate.verification.credentials.username;
    }
    if (candidate.verification?.credentials?.apiPort) {
        created.router.apiPort = candidate.verification.credentials.apiPort;
    }
    if (candidate.verification?.credentials?.credentialSecretRef) {
        created.router.credentialState = created.router.credentialState || {};
        created.router.credentialState.secretRef = candidate.verification.credentials.credentialSecretRef;
        created.router.credentialState.state = 'active';
        created.router.credentialState.lastVerifiedAt = new Date();
        await attachCredentialToRouter(created.router._id, { _id: candidate.verification.credentials.credentialSecretRef }, { state: 'active' });
    }
    if (metadata.routerosVersion) {
        created.router.routerosVersion = metadata.routerosVersion;
    }
    created.router.lastSeen = new Date();
    if (candidate.verification?.method === 'api') {
        created.router.lastApiSuccessAt = new Date();
    }
    created.router.lastApiError = null;
    created.router.lastApiErrorAt = null;
    created.router.adminNotes.push({
        body: `Imported from discovery. Local IP: ${candidate.ipAddress}${metadata.identity ? ` · Identity: ${metadata.identity}` : ''}${reason ? ` · ${reason}` : ''}`,
        category: 'provisioning',
        pinned: true,
        author: 'system'
    });

    if (!Array.isArray(created.router.managementEndpoints) || !created.router.managementEndpoints.length) {
        const localAddress = String(candidate.ipAddress || '').trim();
        const apiPort = Array.isArray(candidate.openPorts) && candidate.openPorts.includes(8728)
            ? 8728
            : (candidate.verification?.credentials?.apiPort || 8728);
        created.router.managementEndpoints = localAddress ? [{
            id: 'import-local-api',
            kind: apiPort === 8729 ? 'local_api_tls' : 'local_api',
            host: localAddress,
            port: apiPort,
            transport: apiPort === 8729 ? 'api_ssl' : 'api',
            source: 'discovery',
            priority: 10,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'strict',
            authScope: 'unknown',
            health: 'unknown',
            consecutiveFailures: 0
        }] : [];
    }
    await created.router.save();

    try {
        const capabilities = await probeCapabilities((routerId, operationName, execContext) => executeRouterOperation(
            routerId,
            operationName,
            execContext,
            { actor: 'system', actorType: 'system' }
        ), created.router._id);

        created.router.capabilities = {
            ...(created.router.capabilities || {}),
            ...capabilities,
            principal: candidate.verification?.credentials?.username || null
        };
        created.router.credentialState = {
            ...(created.router.credentialState || {}),
            state: 'active',
            lastVerifiedAt: new Date(),
            verificationFailureCount: 0
        };
        await created.router.save();
    } catch (error) {
        created.router.failureState = {
            ...(created.router.failureState || {}),
            current: error.failureType || 'transport_error',
            firstFailedAt: created.router.failureState?.firstFailedAt || new Date(),
            lastFailedAt: new Date(),
            lastError: error.message || String(error)
        };
        await created.router.save().catch(() => undefined);
    }

    candidate.importedRouterId = created.router._id;
    candidate.importedAt = new Date();
    candidate.verification.status = 'imported';
    await session.save();
    const artifacts = importMode === 'management_only'
        ? null
        : await generateRouterSetupArtifacts(created.router._id).catch(() => null);

    return {
        router: {
            id: String(created.router._id),
            name: created.router.name,
            vpnIp: created.router.vpnIp,
            ports: created.router.ports,
            status: created.router.status,
            connectionMode: created.router.connectionMode || importMode
        },
        artifacts,
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
