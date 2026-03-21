const crypto = require('crypto');
const MikrotikRouter = require('../models/MikrotikRouter');
const RouterOnboardingClaim = require('../models/RouterOnboardingClaim');
const User = require('../models/User');
const RouterDiscoverySession = require('../models/RouterDiscoverySession');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { recordAdminAction } = require('../services/admin-audit-service');
const { getSystemResource, getInterfaces, pingTest, rebootRouter, resolveRouterManagementHost, executeCommand } = require('../services/routeros-command-service');
const { rotateCredential, markCredentialVerified } = require('../services/router-credential-service');
const { execute: executeRouterOperation } = require('../services/router-execution-service');
const { probeCapabilities } = require('../services/capability-probe-service');
const { getRouterMetricsHistory } = require('../services/telemetry-service');
const {
    startDiscoveryScan,
    listDiscoveryResults,
    verifyDiscoveryCandidate,
    importDiscoveryCandidate
} = require('../services/router-discovery-service');
const {
    ADMIN_ROUTER_PERMISSIONS,
    ROUTER_NOTE_CATEGORIES,
    ROUTER_FLAG_TYPES,
    ROUTER_FLAG_SEVERITIES,
    listAdminRouters,
    getAdminRouterStats,
    getAdminRouterDetail,
    getAdminRouterConnectivity,
    getAdminRouterPorts,
    getAdminRouterMonitoring,
    getAdminRouterActivity,
    getAdminRouterProvisioning,
    getAdminRouterDiagnostics,
    getAdminRouterNotes,
    getAdminRouterFlags,
    createRouterAdmin,
    generateRouterSetupArtifacts,
    disableRouter,
    reactivateRouter,
    resetRouterPeer,
    reprovisionRouter,
    reassignRouterPorts,
    markRouterProvisioningReviewed,
    deleteRouterAdmin
} = require('../services/admin-router-service');

function normalizeReason(value) {
    return value ? String(value).trim() : '';
}

function normalizeText(value) {
    const normalized = value == null ? '' : String(value).trim();
    return normalized || null;
}

function resolveRequestIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
        return forwardedFor.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || null;
}

function isExpired(claim) {
    return !!claim?.expiresAt && new Date(claim.expiresAt).getTime() < Date.now();
}

function markExpiredIfNeeded(claim) {
    if (claim && ['pending', 'claimed'].includes(claim.status) && isExpired(claim)) {
        claim.status = 'expired';
    }
    return claim;
}

function getPublicApiBaseUrl(req) {
    const configured = process.env.PUBLIC_API_URL || process.env.SERVICE_URL_WIREGUARD;
    if (configured) {
        return String(configured).replace(/\/$/, '');
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${process.env.API_PORT || process.env.PORT || 5000}`;
    return `${protocol}://${host}`;
}

function getRouterManagementHost(router) {
    return resolveRouterManagementHost(router);
}

function getActorContext(req) {
    return {
        actor: req.adminUser?.email || 'admin',
        actorType: 'admin',
        requestId: req.headers['x-request-id'] || null
    };
}

function resolveRouterExecutionError(error, fallbackMessage) {
    const message = error?.message || fallbackMessage;
    if (message === 'Router not found') {
        return { status: 404, payload: { success: false, error: message } };
    }
    if (message === 'capability_missing' || error?.failureType === 'capability_missing') {
        return { status: 403, payload: { success: false, error: 'Router capability missing', code: 'capability_missing' } };
    }
    if (message === 'unsafe_operation_blocked' || error?.failureType === 'unsafe_operation_blocked') {
        return { status: 403, payload: { success: false, error: 'Operation blocked by router safety policy', code: 'unsafe_operation_blocked' } };
    }
    return { status: 500, payload: { success: false, error: fallbackMessage, details: message } };
}

function buildClaimBootstrapScript(claimToken, callbackUrl) {
    const safeToken = String(claimToken).replace(/"/g, '');
    return [
        `:local claimToken "${safeToken}";`,
        `:local callbackUrl "${callbackUrl}";`,
        ':local requestUrl ($callbackUrl . "?token=" . $claimToken);',
        '/tool fetch url=$requestUrl keep-result=no output=none;',
        ':put "Router claim submitted. Return to the admin panel to adopt this router.";'
    ].join('\n');
}

function serializeClaim(claim) {
    return {
        id: String(claim._id),
        user: claim.userId ? {
            id: String(claim.userId._id || claim.userId),
            name: claim.userId.name || 'Unknown subscriber',
            email: claim.userId.email || ''
        } : null,
        requestedName: claim.requestedName,
        serverNode: claim.serverNode || 'wireguard',
        reason: claim.reason || '',
        expectedAddressHint: claim.expectedAddressHint || null,
        status: claim.status,
        expiresAt: claim.expiresAt,
        claimedAt: claim.claimedAt || null,
        adoptedAt: claim.adoptedAt || null,
        cancelledAt: claim.cancelledAt || null,
        provisionedRouterId: claim.provisionedRouterId ? String(claim.provisionedRouterId) : null,
        detected: {
            sourceIp: claim.detected?.sourceIp || null,
            userAgent: claim.detected?.userAgent || null,
            identity: claim.detected?.identity || null,
            boardName: claim.detected?.boardName || null,
            serialNumber: claim.detected?.serialNumber || null,
            routerosVersion: claim.detected?.routerosVersion || null,
            wanIp: claim.detected?.wanIp || null,
            lanIp: claim.detected?.lanIp || null,
            lastSeenAt: claim.detected?.lastSeenAt || null,
            matchedExpectedAddress: typeof claim.detected?.matchedExpectedAddress === 'boolean' ? claim.detected.matchedExpectedAddress : null
        },
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt
    };
}

function parseRouterKeyValueOutput(output) {
    const result = {};
    String(output || '')
        .split('\n')
        .map((line) => line.trim())
        .forEach((line) => {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (!match) return;
            const key = match[1].trim();
            const normalizedKey = key.replace(/\s+/g, '').replace(/-([a-z])/g, (_, character) => character.toUpperCase());
            result[normalizedKey.charAt(0).toLowerCase() + normalizedKey.slice(1)] = match[2].trim();
        });
    return result;
}

function parseSizeToBytes(value) {
    if (!value) return null;
    const match = String(value).trim().match(/^([\d.]+)\s*([kmgti]?i?b?)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (Number.isNaN(amount)) return null;
    const unit = (match[2] || '').toLowerCase();
    const multipliers = {
        '': 1,
        b: 1,
        k: 1024,
        kb: 1024,
        kib: 1024,
        m: 1024 ** 2,
        mb: 1024 ** 2,
        mib: 1024 ** 2,
        g: 1024 ** 3,
        gb: 1024 ** 3,
        gib: 1024 ** 3,
        t: 1024 ** 4,
        tb: 1024 ** 4,
        tib: 1024 ** 4,
    };
    return Math.round(amount * (multipliers[unit] || 1));
}

function parseCpuLoad(value) {
    if (!value) return null;
    const parsed = Number(String(value).replace(/[^\d.]/g, ''));
    return Number.isNaN(parsed) ? null : parsed;
}

function parsePingOutput(output) {
    const packetsSent = (String(output || '').match(/sent=(\d+)/i) || [])[1];
    const packetsReceived = (String(output || '').match(/received=(\d+)/i) || [])[1];
    const packetLoss = (String(output || '').match(/packet-loss=([\d.]+%?)/i) || [])[1];
    const avgRtt = (String(output || '').match(/avg-rtt=([\d.]+(?:ms)?)/i) || [])[1];

    const sent = packetsSent ? Number(packetsSent) : undefined;
    const received = packetsReceived ? Number(packetsReceived) : undefined;
    const parsedLoss = packetLoss ? Number(String(packetLoss).replace('%', '')) : undefined;
    const parsedRtt = avgRtt ? Number(String(avgRtt).replace(/ms/i, '')) : undefined;

    return {
        reachable: (received || 0) > 0,
        packetsSent: sent,
        packetsReceived: received,
        packetLoss: parsedLoss,
        avgRtt: parsedRtt
    };
}

function parseInterfacesOutput(output) {
    const interfaces = [];
    const lines = String(output || '').split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !/^\d+\s/.test(line)) continue;

        const typeMatch = line.match(/\btype="?([^"\s]+)"?/i);
        const nameMatch = line.match(/\bname="?([^"\s]+)"?/i);
        const disabledMatch = line.match(/\bdisabled=(yes|no|true|false)\b/i);
        const runningMatch = line.match(/\brunning=(yes|no|true|false)\b/i);
        const commentMatch = line.match(/\bcomment="?([^"]*)"?$/i);

        interfaces.push({
            name: nameMatch?.[1] || line.replace(/^\d+\s+/, '').split(/\s+/)[0] || 'unknown',
            type: typeMatch?.[1] || 'unknown',
            running: runningMatch ? ['yes', 'true'].includes(runningMatch[1].toLowerCase()) : /\bR\b/.test(line),
            disabled: disabledMatch ? ['yes', 'true'].includes(disabledMatch[1].toLowerCase()) : false,
            comment: commentMatch?.[1] || null
        });
    }
    return interfaces;
}

async function getRouterOr404(req, res) {
    const router = await MikrotikRouter.findById(req.params.id).populate('userId');
    if (!router) {
        res.status(404).json({ success: false, error: 'Router not found' });
        return null;
    }
    return router;
}

async function resolveCustomerUser(identifier) {
    const value = String(identifier || '').trim();
    if (!value) return null;
    const query = value.includes('@') ? { email: value.toLowerCase() } : { _id: value };
    const user = await User.findOne(query);
    if (!user || user.role !== 'user') return null;
    return user;
}

async function audit(req, router, action, reason, metadata = {}) {
    return recordAdminAction({
        req,
        actorUserId: req.adminUser._id,
        targetUserId: router.userId?._id || router.userId || null,
        targetRouterId: router._id,
        action,
        reason,
        metadata
    });
}

function registerAdminRouterRoutes(app) {
    const handleRouterOnboardingClaim = async (req, res) => {
        try {
            const token = String(req.body?.token || req.query?.token || '').trim();
            if (!token) {
                return res.status(400).json({ success: false, error: 'Claim token is required' });
            }

            const claim = await RouterOnboardingClaim.findOne({ tokenHash: RouterOnboardingClaim.hashToken(token) });
            if (!claim) {
                return res.status(404).json({ success: false, error: 'Invalid claim token' });
            }

            markExpiredIfNeeded(claim);
            if (claim.status === 'expired') {
                await claim.save();
                return res.status(410).json({ success: false, error: 'Claim token has expired' });
            }
            if (claim.status === 'cancelled') {
                return res.status(409).json({ success: false, error: 'Claim token has been cancelled' });
            }
            if (claim.status === 'adopted') {
                return res.json({ success: true, status: 'adopted', message: 'Claim already adopted' });
            }

            const sourceIp = resolveRequestIp(req);
            const expected = normalizeText(claim.expectedAddressHint);
            const matchedExpectedAddress = expected ? sourceIp === expected : null;
            claim.status = 'claimed';
            claim.claimedAt = claim.claimedAt || new Date();
            claim.detected = {
                ...claim.detected,
                sourceIp,
                userAgent: normalizeText(req.get('user-agent')),
                identity: normalizeText(req.body?.identity || req.query?.identity),
                boardName: normalizeText(req.body?.boardName || req.query?.boardName),
                serialNumber: normalizeText(req.body?.serialNumber || req.query?.serialNumber),
                routerosVersion: normalizeText(req.body?.routerosVersion || req.query?.routerosVersion),
                wanIp: normalizeText(req.body?.wanIp || req.query?.wanIp),
                lanIp: normalizeText(req.body?.lanIp || req.query?.lanIp),
                lastSeenAt: new Date(),
                matchedExpectedAddress
            };
            await claim.save();

            return res.json({
                success: true,
                status: claim.status,
                message: 'Router claim accepted. Return to the admin panel to adopt this router.',
                claimId: String(claim._id)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to process router claim', details: error.message });
        }
    };

    app.get('/api/router-onboarding/claim', handleRouterOnboardingClaim);
    app.post('/api/router-onboarding/claim', handleRouterOnboardingClaim);

    app.get('/api/admin/routers/stats', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const stats = await getAdminRouterStats();
            res.json({ success: true, stats });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Failed to load router stats', details: error.message });
        }
    });

    app.get('/api/admin/routers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const result = await listAdminRouters(req.query || {});
            if (result.format === 'csv') {
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', 'attachment; filename="admin-routers-export.csv"');
                return res.send(result.csv);
            }

            return res.json({ success: true, items: result.items, pagination: result.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load routers', details: error.message });
        }
    });

    app.get('/api/admin/routers/onboarding/claims', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const query = {};
            const requestedStatus = String(req.query?.status || '').trim();
            if (requestedStatus) {
                query.status = requestedStatus;
            }

            const claims = await RouterOnboardingClaim.find(query)
                .populate('userId', 'name email')
                .sort({ createdAt: -1 })
                .limit(50);

            let changed = false;
            for (const claim of claims) {
                if (['pending', 'claimed'].includes(claim.status) && isExpired(claim)) {
                    claim.status = 'expired';
                    await claim.save();
                    changed = true;
                }
            }

            const items = (changed
                ? await RouterOnboardingClaim.find(query).populate('userId', 'name email').sort({ createdAt: -1 }).limit(50)
                : claims
            ).map(serializeClaim);

            return res.json({ success: true, items });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router onboarding claims', details: error.message });
        }
    });

    app.post('/api/admin/routers/discovery/scan', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const session = await startDiscoveryScan({
                adminUserId: req.adminUser._id,
                requestedSubnet: normalizeText(req.body?.subnet),
                reason: normalizeReason(req.body?.reason)
            });

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                action: 'admin_start_router_discovery_scan',
                reason: normalizeReason(req.body?.reason),
                metadata: {
                    discoverySessionId: session.id,
                    requestedSubnet: session.requestedSubnet,
                    source: session.source
                }
            });

            return res.status(202).json({ success: true, session });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to start router discovery scan', details: error.message });
        }
    });

    app.get('/api/admin/routers/discovery/results', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW), async (req, res) => {
        try {
            const sessions = await listDiscoveryResults({ sessionId: req.query?.sessionId });
            return res.json({ success: true, items: sessions });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router discovery results', details: error.message });
        }
    });

    app.post('/api/admin/routers/discovery/verify', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const sessionId = String(req.body?.sessionId || '').trim();
            const candidateId = String(req.body?.candidateId || '').trim();
            const username = String(req.body?.username || '').trim();
            const password = String(req.body?.password || '');
            const method = String(req.body?.method || 'auto').trim();

            if (!sessionId || !candidateId || !username || !password) {
                return res.status(400).json({ success: false, error: 'sessionId, candidateId, username, and password are required' });
            }

            const result = await verifyDiscoveryCandidate({ sessionId, candidateId, username, password, method });
            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                action: 'admin_verify_discovered_router',
                reason: '',
                metadata: {
                    discoverySessionId: sessionId,
                    candidateId,
                    ipAddress: result.candidate.ipAddress,
                    verificationStatus: result.candidate.verification?.status || 'unknown',
                    verificationMethod: result.candidate.verification?.method || method
                }
            });

            return res.json({ success: true, session: result.session, candidate: result.candidate });
        } catch (error) {
            const statusCode = /not found/i.test(error.message) ? 404 : (/already/i.test(error.message) ? 409 : 400);
            return res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.post('/api/admin/routers/discovery/import', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const sessionId = String(req.body?.sessionId || '').trim();
            const candidateId = String(req.body?.candidateId || '').trim();
            const targetUser = await resolveCustomerUser(req.body?.userId);
            const routerName = normalizeText(req.body?.name);
            const serverNode = String(req.body?.serverNode || 'wireguard').trim() || 'wireguard';
            const reason = normalizeReason(req.body?.reason);
            const connectionMode = String(req.body?.connectionMode || 'wireguard').trim() || 'wireguard';

            if (!sessionId || !candidateId || !targetUser) {
                return res.status(400).json({ success: false, error: 'sessionId, candidateId, and a valid customer userId/email are required' });
            }

            const imported = await importDiscoveryCandidate({
                sessionId,
                candidateId,
                userId: String(targetUser._id),
                name: routerName,
                serverNode,
                reason,
                connectionMode
            });

            const persistedSession = await RouterDiscoverySession.findById(sessionId);
            const persistedCandidate = persistedSession?.candidates.id(candidateId);
            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: targetUser._id,
                targetRouterId: imported.router.id,
                action: 'admin_import_discovered_router',
                reason,
                metadata: {
                    discoverySessionId: sessionId,
                    candidateId,
                    ipAddress: imported.candidate.ipAddress,
                    serialNumber: imported.candidate.verification?.metadata?.serialNumber || null,
                    importedRouterId: imported.router.id
                }
            });

            return res.status(201).json({
                success: true,
                message: 'Router imported successfully',
                router: imported.router,
                artifacts: imported.artifacts || null,
                session: imported.session,
                candidate: imported.candidate,
                verificationExpiresAt: persistedCandidate?.verification?.expiresAt || null
            });
        } catch (error) {
            const statusCode = /already/i.test(error.message) ? 409 : (/not found/i.test(error.message) ? 404 : 400);
            return res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.post('/api/admin/routers/onboarding/claims', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const targetUser = await resolveCustomerUser(req.body?.userId);
            const requestedName = String(req.body?.name || '').trim();
            const serverNode = String(req.body?.serverNode || 'wireguard').trim() || 'wireguard';
            const reason = normalizeReason(req.body?.reason);
            const expectedAddressHint = normalizeText(req.body?.expectedAddressHint);
            const expiresInHours = Math.min(72, Math.max(1, Number(req.body?.expiresInHours || 24)));

            if (!targetUser) {
                return res.status(404).json({ success: false, error: 'Target customer not found' });
            }
            if (!requestedName) {
                return res.status(400).json({ success: false, error: 'Router name is required' });
            }

            const plainToken = crypto.randomBytes(18).toString('base64url');
            const callbackUrl = `${getPublicApiBaseUrl(req)}/api/router-onboarding/claim`;
            const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

            const claim = await RouterOnboardingClaim.create({
                userId: targetUser._id,
                requestedName,
                serverNode,
                reason,
                expectedAddressHint,
                tokenHash: RouterOnboardingClaim.hashToken(plainToken),
                expiresAt
            });

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: targetUser._id,
                action: 'admin_create_router_onboarding_claim',
                reason,
                metadata: {
                    claimId: claim._id,
                    requestedName,
                    serverNode,
                    expectedAddressHint,
                    expiresAt
                }
            });

            return res.status(201).json({
                success: true,
                claim: serializeClaim(await claim.populate('userId', 'name email')),
                token: plainToken,
                callbackUrl,
                bootstrapScript: buildClaimBootstrapScript(plainToken, callbackUrl)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create router claim', details: error.message });
        }
    });

    app.post('/api/admin/routers/onboarding/claims/:id/adopt', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const claim = await RouterOnboardingClaim.findById(req.params.id).populate('userId');
            if (!claim) {
                return res.status(404).json({ success: false, error: 'Router claim not found' });
            }

            markExpiredIfNeeded(claim);
            if (claim.status === 'expired') {
                await claim.save();
                return res.status(410).json({ success: false, error: 'Claim has expired and can no longer be adopted' });
            }
            if (claim.status === 'cancelled') {
                return res.status(409).json({ success: false, error: 'Cancelled claims cannot be adopted' });
            }
            if (claim.status === 'adopted' && claim.provisionedRouterId) {
                return res.json({ success: true, message: 'Claim already adopted', routerId: String(claim.provisionedRouterId) });
            }
            if (claim.status !== 'claimed') {
                return res.status(400).json({ success: false, error: 'The router has not called home yet. Run the bootstrap script first.' });
            }

            const routerName = normalizeText(req.body?.name) || claim.requestedName || claim.detected?.identity || `router-${String(claim.userId._id).slice(-6)}`;
            const created = await createRouterAdmin({
                userId: String(claim.userId._id),
                name: routerName,
                serverNode: claim.serverNode || 'wireguard',
                notes: `Provisioned from router claim ${String(claim._id)}`
            });

            created.router.routerboardInfo = {
                ...(created.router.routerboardInfo || {}),
                boardName: claim.detected?.boardName || created.router.routerboardInfo?.boardName,
                model: claim.detected?.identity || created.router.routerboardInfo?.model,
                serialNumber: claim.detected?.serialNumber || created.router.routerboardInfo?.serialNumber,
                firmware: claim.detected?.routerosVersion || created.router.routerboardInfo?.firmware,
                lastChecked: claim.detected?.lastSeenAt || new Date()
            };
            if (claim.detected?.sourceIp || claim.detected?.identity) {
                created.router.adminNotes.push({
                    body: `Adopted from claim. Source IP: ${claim.detected?.sourceIp || 'unknown'}${claim.detected?.identity ? ` · Identity: ${claim.detected.identity}` : ''}${claim.detected?.serialNumber ? ` · Serial: ${claim.detected.serialNumber}` : ''}`,
                    category: 'provisioning',
                    pinned: true,
                    author: req.adminUser.email || 'system'
                });
            }
            await created.router.save();

            claim.status = 'adopted';
            claim.adoptedAt = new Date();
            claim.provisionedRouterId = created.router._id;
            await claim.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: claim.userId._id,
                targetRouterId: created.router._id,
                action: 'admin_adopt_claimed_router',
                reason: normalizeReason(req.body?.reason) || claim.reason || '',
                metadata: {
                    claimId: claim._id,
                    detectedSourceIp: claim.detected?.sourceIp || null,
                    detectedIdentity: claim.detected?.identity || null
                }
            });

            return res.json({
                success: true,
                message: 'Router adopted successfully',
                router: {
                    id: String(created.router._id),
                    name: created.router.name,
                    vpnIp: created.router.vpnIp,
                    ports: created.router.ports,
                    status: created.router.status
                },
                claim: serializeClaim(claim)
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to adopt router claim', details: error.message });
        }
    });

    app.post('/api/admin/routers/onboarding/claims/:id/cancel', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const claim = await RouterOnboardingClaim.findById(req.params.id).populate('userId', 'name email');
            if (!claim) {
                return res.status(404).json({ success: false, error: 'Router claim not found' });
            }
            if (claim.status === 'adopted') {
                return res.status(409).json({ success: false, error: 'Adopted claims cannot be cancelled' });
            }

            claim.status = 'cancelled';
            claim.cancelledAt = new Date();
            await claim.save();

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: claim.userId?._id || claim.userId,
                action: 'admin_cancel_router_onboarding_claim',
                reason: normalizeReason(req.body?.reason) || claim.reason || '',
                metadata: { claimId: claim._id }
            });

            return res.json({ success: true, message: 'Router claim cancelled', claim: serializeClaim(claim) });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to cancel router claim', details: error.message });
        }
    });

    app.post('/api/admin/routers', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.CREATE), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '').trim();
            const name = String(req.body?.name || '').trim();
            const serverNode = String(req.body?.serverNode || 'wireguard').trim() || 'wireguard';
            const reason = normalizeReason(req.body?.reason);

            if (!userId) {
                return res.status(400).json({ success: false, error: 'Customer user ID is required' });
            }
            if (!name) {
                return res.status(400).json({ success: false, error: 'Router name is required' });
            }

            const targetUser = await resolveCustomerUser(userId);
            if (!targetUser) {
                return res.status(404).json({ success: false, error: 'Target customer not found' });
            }

            const created = await createRouterAdmin({
                userId: String(targetUser._id),
                name,
                serverNode,
                notes: reason || ''
            });

            await recordAdminAction({
                req,
                actorUserId: req.adminUser._id,
                targetUserId: created.owner._id,
                targetRouterId: created.router._id,
                action: 'admin_create_router',
                reason,
                metadata: {
                    serverNode,
                    vpnIp: created.router.vpnIp,
                    ports: created.router.ports
                }
            });

            return res.status(201).json({
                success: true,
                data: {
                    id: String(created.router._id),
                    name: created.router.name,
                    vpnIp: created.router.vpnIp,
                    ports: created.router.ports,
                    status: created.router.status,
                    wireguardConfig: created.artifacts?.wireguardConfig
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to create router', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const detail = await getAdminRouterDetail(req.params.id);
            if (!detail) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, data: detail });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router details', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/connectivity', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_CONNECTIVITY), async (req, res) => {
        try {
            const connectivity = await getAdminRouterConnectivity(req.params.id);
            if (!connectivity) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, connectivity });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router connectivity', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/set-credentials', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const apiUsername = normalizeText(req.body?.apiUsername);
            const apiPassword = req.body?.apiPassword == null ? null : String(req.body.apiPassword).trim();
            const apiPortValue = req.body?.apiPort;
            const apiPort = apiPortValue == null || apiPortValue === '' ? null : Number(apiPortValue);

            if (apiPort != null && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)) {
                return res.status(400).json({ success: false, error: 'API port must be between 1 and 65535' });
            }

            const nextUsername = apiUsername || 'admin';
            const nextPort = apiPort != null ? apiPort : (router.apiPort || 8728);
            let pendingCredential = null;

            router.apiUsername = nextUsername;
            if (apiPassword != null) {
                router.apiPassword = apiPassword;
                pendingCredential = await rotateCredential({
                    router,
                    principal: nextUsername,
                    secret: apiPassword,
                    transportHint: 'api',
                    apiPort: nextPort,
                    createdBy: req.adminUser.email
                });
                router.credentialState = router.credentialState || {};
                router.credentialState.secretRef = pendingCredential._id;
                router.credentialState.state = 'rotating';
            }
            if (apiPort != null) {
                router.apiPort = nextPort;
            }
            await router.save();

            await audit(req, router, 'admin.routers.set_credentials', normalizeReason(req.body?.reason) || 'Updated RouterOS API credentials', {
                apiUsername: router.apiUsername,
                apiPort: router.apiPort,
                hasPassword: Boolean(router.apiPassword)
            });

            return res.json({
                success: true,
                message: 'RouterOS API credentials updated',
                data: {
                    apiUsername: router.apiUsername,
                    apiPort: router.apiPort,
                    hasPassword: Boolean(router.apiPassword),
                    credentialState: {
                        secretConfigured: Boolean(router.credentialState?.secretRef),
                        state: router.credentialState?.state || 'unknown'
                    }
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to update router credentials', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/test-connection', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_CONNECTIVITY), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const [resource, interfaces] = await Promise.all([
                getSystemResource(req.params.id, getActorContext(req)),
                getInterfaces(req.params.id, getActorContext(req))
            ]);
            const capabilities = await probeCapabilities((routerId, operationName, execContext) => executeRouterOperation(
                routerId,
                operationName,
                execContext,
                getActorContext(req)
            ), req.params.id);

            if (router.credentialState?.secretRef) {
                await markCredentialVerified(req.params.id, router.credentialState.secretRef);
            }

            router.capabilities = { ...(router.capabilities || {}), ...capabilities };
            router.credentialState = {
                ...(router.credentialState || {}),
                state: 'active',
                lastVerifiedAt: new Date(),
                verificationFailureCount: 0
            };
            await router.save();

            await audit(req, router, 'admin.routers.test_connection', normalizeReason(req.body?.reason) || 'Tested RouterOS API connectivity', {
                apiPort: router.apiPort || 8728
            });

            return res.json({
                success: true,
                data: {
                    resource,
                    interfaces,
                    capabilities,
                    credentialState: {
                        secretConfigured: Boolean(router.credentialState?.secretRef),
                        state: router.credentialState?.state || 'unknown',
                        lastVerifiedAt: router.credentialState?.lastVerifiedAt || null
                    },
                    testedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            return res.status(502).json({ success: false, error: 'Failed to connect to router via RouterOS API', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/ports', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const ports = await getAdminRouterPorts(req.params.id);
            if (!ports) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, ports });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router ports', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/monitoring', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_MONITORING), async (req, res) => {
        try {
            const monitoring = await getAdminRouterMonitoring(req.params.id);
            if (!monitoring) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, monitoring });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router monitoring', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/metrics', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_MONITORING), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const hours = Math.min(168, Math.max(1, Number(req.query?.hours || 24)));
            const metrics = await getRouterMetricsHistory(req.params.id, hours);
            return res.json({ success: true, metrics, routerId: req.params.id });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router metrics', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/activity', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const activity = await getAdminRouterActivity(req.params.id, req.query || {});
            if (!activity) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: activity.items, pagination: activity.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router activity', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/provisioning', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const provisioning = await getAdminRouterProvisioning(req.params.id);
            if (!provisioning) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, provisioning });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router provisioning state', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/diagnostics', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const diagnostics = await getAdminRouterDiagnostics(req.params.id);
            if (!diagnostics) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, diagnostics });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router diagnostics', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/notes', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
        try {
            const notes = await getAdminRouterNotes(req.params.id);
            if (!notes) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: notes });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router notes', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/notes', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.ADD_NOTE), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (!req.body?.body || !String(req.body.body).trim()) {
                return res.status(400).json({ success: false, error: 'Note body is required' });
            }
            if (req.body.category && !ROUTER_NOTE_CATEGORIES.includes(req.body.category)) {
                return res.status(400).json({ success: false, error: 'Invalid note category', categories: ROUTER_NOTE_CATEGORIES });
            }

            router.adminNotes.push({
                body: String(req.body.body).trim(),
                category: req.body.category || 'support',
                pinned: Boolean(req.body.pinned),
                author: req.adminUser.email
            });
            await router.save();
            await audit(req, router, 'admin.routers.add_note', normalizeReason(req.body.reason), {
                category: req.body.category || 'support',
                pinned: Boolean(req.body.pinned)
            });

            return res.json({ success: true, message: 'Router note added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add router note', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/flags', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const flags = await getAdminRouterFlags(req.params.id);
            if (!flags) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }

            return res.json({ success: true, items: flags });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to load router flags', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/flags', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (!req.body?.flag) {
                return res.status(400).json({ success: false, error: 'Flag name is required' });
            }
            if (!ROUTER_FLAG_TYPES.includes(req.body.flag)) {
                return res.status(400).json({ success: false, error: 'Invalid flag type', flagTypes: ROUTER_FLAG_TYPES });
            }
            if (req.body.severity && !ROUTER_FLAG_SEVERITIES.includes(req.body.severity)) {
                return res.status(400).json({ success: false, error: 'Invalid flag severity', severities: ROUTER_FLAG_SEVERITIES });
            }

            router.internalFlags.push({
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || '',
                createdBy: req.adminUser.email
            });
            await router.save();
            await audit(req, router, 'admin.routers.add_flag', normalizeReason(req.body.reason), {
                flag: req.body.flag,
                severity: req.body.severity || 'medium',
                description: req.body.description || ''
            });

            return res.json({ success: true, message: 'Router flag added successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to add router flag', details: error.message });
        }
    });

    app.delete('/api/admin/routers/:id/flags/:flagId', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.FLAG), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const flag = router.internalFlags.id(req.params.flagId);
            if (!flag) {
                return res.status(404).json({ success: false, error: 'Flag not found' });
            }

            const removed = { flag: flag.flag, severity: flag.severity, description: flag.description };
            flag.deleteOne();
            await router.save();
            await audit(req, router, 'admin.routers.remove_flag', normalizeReason(req.body?.reason), removed);

            return res.json({ success: true, message: 'Router flag removed successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to remove router flag', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/disable', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const bundle = await disableRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.disable', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router disabled successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to disable router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reactivate', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const bundle = await reactivateRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.reactivate', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router reactivated successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reactivate router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reprovision', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REPROVISION), async (req, res) => {
        try {
            const bundle = await reprovisionRouter(req.params.id);
            if (!bundle) {
                return res.status(404).json({ success: false, error: 'Router not found' });
            }
            await audit(req, bundle.router, 'admin.routers.reprovision', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Router reprovisioned successfully' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reprovision router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/regenerate-setup', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REPROVISION), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const artifacts = await generateRouterSetupArtifacts(req.params.id);
            await audit(req, router, 'admin.routers.regenerate_setup', normalizeReason(req.body?.reason), { generatedAt: artifacts.generatedAt });
            return res.json({ success: true, message: 'Router setup regenerated successfully', artifacts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to regenerate router setup', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reset-peer', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.RESET_KEYS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const artifacts = await resetRouterPeer(req.params.id);
            await audit(req, router, 'admin.routers.reset_peer', normalizeReason(req.body?.reason), { generatedAt: artifacts.generatedAt });
            return res.json({ success: true, message: 'Router peer reset successfully', artifacts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reset router peer', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reassign-ports', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.REASSIGN_PORTS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const result = await reassignRouterPorts(req.params.id, req.body?.ports || null);
            await audit(req, router, 'admin.routers.reassign_ports', normalizeReason(req.body?.reason), result);
            return res.json({ success: true, message: 'Router ports reassigned successfully', ...result });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reassign router ports', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/move-server', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MOVE_SERVER), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            return res.status(409).json({
                success: false,
                error: 'Router server moves are not supported in the current single-node WireGuard architecture',
                currentServerNode: router.serverNode || 'wireguard'
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to evaluate router server move', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/mark-reviewed', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const updated = await markRouterProvisioningReviewed(req.params.id, req.adminUser.email);
            await audit(req, router, 'admin.routers.mark_reviewed', normalizeReason(req.body?.reason), { reviewedAt: updated.provisioningReviewedAt });
            return res.json({ success: true, message: 'Router provisioning marked as reviewed', reviewedAt: updated.provisioningReviewedAt });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to mark router as reviewed', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/reboot', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            if (router.status !== 'active') {
                return res.status(400).json({ success: false, error: 'Router is not online' });
            }

            await rebootRouter(req.params.id, getActorContext(req));

            await audit(req, router, 'admin.routers.reboot', normalizeReason(req.body?.reason), {});
            return res.json({ success: true, message: 'Reboot command sent' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to reboot router', details: error.message });
        }
    });

    app.post('/api/admin/routers/:id/ping', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        let router = null;
        const requestedAddress = String(req.body?.address || '').trim();
        const count = Math.max(1, Math.min(10, Number(req.body?.count || 4) || 4));
        try {
            router = await getRouterOr404(req, res);
            if (!router) return;

            const address = requestedAddress || (router.connectionMode === 'management_only' ? '8.8.8.8' : '10.0.0.1');
            const result = await pingTest(req.params.id, address, count, getActorContext(req));
            const historyEntry = {
                target: address,
                reachable: result.received > 0,
                packetsSent: result.sent,
                packetsReceived: result.received,
                packetLoss: result.packetLoss,
                avgRtt: result.avgRtt,
                error: null,
                actor: req.adminUser?.email || 'admin',
                createdAt: new Date()
            };

            router.pingHistory = [historyEntry, ...(router.pingHistory || [])].slice(0, 20);
            await router.save();

            return res.json({
                success: result.received > 0,
                result: historyEntry
            });
        } catch (error) {
            if (router) {
                const fallbackAddress = requestedAddress || (router.connectionMode === 'management_only' ? '8.8.8.8' : '10.0.0.1');
                router.pingHistory = [{
                    target: fallbackAddress,
                    reachable: false,
                    packetsSent: count,
                    packetsReceived: 0,
                    packetLoss: 100,
                    avgRtt: null,
                    error: error.message || 'Ping failed',
                    actor: req.adminUser?.email || 'admin',
                    createdAt: new Date()
                }, ...(router.pingHistory || [])].slice(0, 20);
                await router.save().catch(() => undefined);
            }
            return res.json({ success: false, reachable: false, error: error.message });
        }
    });

    app.post('/api/admin/routers/:id/command', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.RUN_COMMAND), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const command = String(req.body?.command || '').trim();
            const reason = normalizeReason(req.body?.reason);
            if (!command) {
                return res.status(400).json({ success: false, error: 'Command is required' });
            }
            if (command.length > 500) {
                return res.status(400).json({ success: false, error: 'Command is too long' });
            }

            const breakGlass = Boolean(req.body?.breakGlass);
            const result = await executeRouterOperation(req.params.id, 'raw_command', {
                command,
                breakGlass,
                metadata: {
                    reason,
                    requestedHost: getRouterManagementHost(router)
                }
            }, getActorContext(req));
            await audit(req, router, 'admin.routers.run_command', reason, { command });

            return res.json({
                success: true,
                output: Array.isArray(result.data)
                    ? JSON.stringify(result.data)
                    : (result.data || result.records || '')
            });
        } catch (error) {
            const status = error.failureType === 'unsafe_operation_blocked' || error.message === 'unsafe_operation_blocked' ? 403 : 500;
            return res.status(status).json({ success: false, error: 'Failed to run router command', details: error.message });
        }
    });

    app.get('/api/admin/routers/:id/interfaces', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const interfaces = await getInterfaces(req.params.id, getActorContext(req));
            return res.json({ success: true, interfaces });
        } catch (error) {
            const resolved = resolveRouterExecutionError(error, 'Failed to load interfaces');
            return res.status(resolved.status).json({ ...resolved.payload, interfaces: [] });
        }
    });

    app.get('/api/admin/routers/:id/live-health', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.LIVE_OPS), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;

            const parsed = await getSystemResource(req.params.id, getActorContext(req));
            return res.json({
                success: true,
                health: {
                    uptime: parsed.uptime || null,
                    cpuLoad: parsed.cpuLoad ?? null,
                    freeMemory: parsed.freeMemory ?? null,
                    totalMemory: parsed.totalMemory ?? null,
                    freeHddSpace: parsed.freeHddSpace ?? null,
                    boardName: parsed.boardName || null,
                    routerosVersion: parsed.version || null,
                    reachable: true
                }
            });
        } catch (error) {
            return res.json({
                success: false,
                health: {
                    uptime: null,
                    cpuLoad: null,
                    freeMemory: null,
                    totalMemory: null,
                    freeHddSpace: null,
                    boardName: null,
                    routerosVersion: null,
                    reachable: false,
                    error: error.message
                }
            });
        }
    });

    app.delete('/api/admin/routers/:id', requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.DELETE), async (req, res) => {
        try {
            const router = await getRouterOr404(req, res);
            if (!router) return;
            const result = await deleteRouterAdmin(req.params.id);
            await audit(req, router, 'admin.routers.delete', normalizeReason(req.body?.reason), { routerName: router.name });
            return res.json({ success: true, message: 'Router deleted successfully', data: result });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Failed to delete router', details: error.message });
        }
    });
}

module.exports = registerAdminRouterRoutes;
