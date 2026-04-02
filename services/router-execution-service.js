const crypto = require('crypto');
const MikrotikRouter = require('../models/MikrotikRouter');
const RouterConfigSnapshot = require('../models/RouterConfigSnapshot');
const { executeRouterOsApiCommand } = require('../utils/routeros-api-client');
const { executeRouterOSCommand } = require('./mikrotik-api-service');
const { getResolvedCredential } = require('./router-credential-service');
const { authorizeOperation } = require('./operation-policy-service');
const { startOperation, finalizeOperation } = require('./operation-ledger-service');
const { log } = require('../wg-core');

function stripCidrSuffix(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    return normalized.split('/')[0].trim();
}

function normalizeIdentity(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
}

function getExpectedEndpointBinding(router) {
    const expectedIdentity = normalizeIdentity(
        router?.discoveryInfo?.hostname
        || router?.routerboardInfo?.identity
        || router?.name
    );
    const expectedSerial = String(router?.routerboardInfo?.serialNumber || '').trim().toLowerCase();

    return {
        expectedIdentity,
        expectedSerial
    };
}

function deriveBindingStateForEndpoint(router, endpoint) {
    const kind = String(endpoint?.kind || '').trim().toLowerCase();
    if (router?.connectionMode !== 'management_only' && (kind === 'wireguard_management' || kind === 'wireguard_api')) {
        return 'verified_wireguard';
    }
    return 'verified_local';
}

function appendPathObservation(router, observation = {}) {
    const current = Array.isArray(router.managementPathObservations)
        ? router.managementPathObservations.map((item) => item.toObject ? item.toObject() : { ...item })
        : [];
    return [
        {
            observedAt: new Date(),
            ...observation
        },
        ...current
    ].slice(0, 30);
}

function appendDriftEvent(router, event = {}) {
    const current = Array.isArray(router.driftEvents)
        ? router.driftEvents.map((item) => item.toObject ? item.toObject() : { ...item })
        : [];
    return [
        {
            detectedAt: new Date(),
            ...event
        },
        ...current
    ].slice(0, 25);
}

async function updateEndpointHistoryValidation(routerId, matcher = () => false, updates = {}) {
    const router = await MikrotikRouter.findById(routerId).select('endpointHistory').catch(() => null);
    if (!router || !Array.isArray(router.endpointHistory) || !router.endpointHistory.length) {
        return;
    }

    const nextHistory = router.endpointHistory.map((item) => item.toObject ? item.toObject() : { ...item });
    const index = nextHistory.findIndex(matcher);
    if (index < 0) return;

    nextHistory[index] = {
        ...nextHistory[index],
        ...updates
    };

    await MikrotikRouter.findByIdAndUpdate(routerId, {
        endpointHistory: nextHistory.slice(0, 25)
    }).catch(() => undefined);
}

async function persistEndpointBindingSuccess(routerId, router, endpoint) {
    const now = new Date();
    const expected = getExpectedEndpointBinding(router);
    await MikrotikRouter.findByIdAndUpdate(routerId, {
        endpointBinding: {
            expectedIdentity: expected.expectedIdentity || null,
            expectedSerial: expected.expectedSerial || null,
            state: deriveBindingStateForEndpoint(router, endpoint),
            verifiedEndpointId: endpoint?.id || null,
            verifiedEndpointHost: endpoint?.host || null,
            verifiedTransport: endpoint?.transport || null,
            verifiedAt: now,
            mismatchReason: null,
            lastMismatchAt: null
        },
        managementPathObservations: appendPathObservation(router, {
            endpointId: endpoint?.id || null,
            host: endpoint?.host || null,
            port: endpoint?.port || null,
            transport: endpoint?.transport || null,
            pathType: endpoint?.kind === 'wireguard_management' ? 'wireguard' : 'local',
            operationName: 'endpoint_validation',
            outcome: 'success',
            message: 'Endpoint verified successfully'
        })
    }).catch(() => undefined);
    await updateEndpointHistoryValidation(
        routerId,
        (item) => item.validationState === 'pending' && item.nextHost === (endpoint?.host || null),
        {
            validationState: 'verified',
            validationMessage: `Validated via ${endpoint?.transport || 'api'} on ${endpoint?.host || 'unknown host'}`
        }
    );
}

async function persistEndpointBindingMismatch(routerId, router, endpoint, error) {
    const now = new Date();
    const expected = getExpectedEndpointBinding(router);
    await MikrotikRouter.findByIdAndUpdate(routerId, {
        endpointBinding: {
            expectedIdentity: expected.expectedIdentity || null,
            expectedSerial: expected.expectedSerial || null,
            state: 'mismatch',
            verifiedEndpointId: null,
            verifiedEndpointHost: endpoint?.host || null,
            verifiedTransport: endpoint?.transport || null,
            verifiedAt: null,
            mismatchReason: error?.message || 'Endpoint identity mismatch',
            lastMismatchAt: now
        },
        driftEvents: appendDriftEvent(router, {
            detectedAt: now,
            eventType: 'endpoint_collision',
            severity: 'critical',
            message: error?.message || 'Endpoint identity mismatch',
            previousValue: expected.expectedIdentity || null,
            currentValue: endpoint?.host || null,
            endpointHost: endpoint?.host || null,
            resolvedAt: null
        }),
        managementPathObservations: appendPathObservation(router, {
            endpointId: endpoint?.id || null,
            host: endpoint?.host || null,
            port: endpoint?.port || null,
            transport: endpoint?.transport || null,
            pathType: endpoint?.kind === 'wireguard_management' ? 'wireguard' : 'local',
            operationName: 'endpoint_validation',
            outcome: 'failed',
            failureType: 'stale_endpoint',
            message: error?.message || 'Endpoint identity mismatch'
        })
    }).catch(() => undefined);
    await updateEndpointHistoryValidation(
        routerId,
        (item) => item.validationState === 'pending' && item.nextHost === (endpoint?.host || null),
        {
            validationState: 'mismatch',
            validationMessage: error?.message || 'Endpoint identity mismatch'
        }
    );
}

async function executeViaEndpoint(endpoint, credential, context = {}) {
    if (endpoint.transport === 'ssh') {
        if (context.attributes && Object.keys(context.attributes).length > 0) {
            const unsupported = new Error('Structured RouterOS commands with attributes are not supported over SSH fallback');
            unsupported.failureType = 'transport_error';
            throw unsupported;
        }

        const sshResult = await executeRouterOSCommand(
            endpoint.host,
            context.command,
            credential.username,
            credential.password,
            context.timeout || 5000
        );
        if (!sshResult.success) {
            throw new Error(sshResult.error || 'SSH command failed');
        }

        return {
            endpoint,
            records: sshResult.output,
            data: sshResult.output,
            protocol: 'ssh'
        };
    }

    const apiResult = await executeRouterOsApiCommand({
        host: endpoint.host,
        port: endpoint.port,
        username: credential.username,
        password: credential.password,
        command: context.command,
        attributes: context.attributes || {},
        timeout: context.timeout || 5000
    });
    if (!apiResult.success) {
        throw new Error(apiResult.error || 'RouterOS API command failed');
    }

    return {
        endpoint,
        records: apiResult.data || [],
        data: apiResult.data || [],
        protocol: endpoint.transport
    };
}

async function verifyEndpointBinding(router, endpoint, credential, context = {}) {
    if (router?.connectionMode !== 'management_only' || endpoint.transport === 'ssh') {
        return;
    }

    const { expectedIdentity, expectedSerial } = getExpectedEndpointBinding(router);
    if (!expectedIdentity && !expectedSerial) {
        return;
    }

    const identityResult = await executeViaEndpoint(endpoint, credential, {
        command: '/system/identity/print',
        attributes: {},
        timeout: context.timeout || 5000
    });
    const liveIdentity = normalizeIdentity(identityResult.records?.[0]?.name);

    let liveSerial = '';
    try {
        const routerboardResult = await executeViaEndpoint(endpoint, credential, {
            command: '/system/routerboard/print',
            attributes: {},
            timeout: context.timeout || 5000
        });
        liveSerial = String(routerboardResult.records?.[0]?.['serial-number'] || '').trim().toLowerCase();
    } catch (error) {
        // Some RouterOS roles do not allow routerboard reads. Identity is still useful.
        liveSerial = '';
    }

    const identityMismatch = expectedIdentity && liveIdentity && expectedIdentity !== liveIdentity;
    const serialMismatch = expectedSerial && liveSerial && expectedSerial !== liveSerial;

    if (identityMismatch || serialMismatch) {
        const mismatch = new Error(
            `Endpoint identity mismatch: expected ${router?.discoveryInfo?.hostname || router?.name || 'router'}`
            + ` but endpoint reported ${identityResult.records?.[0]?.name || 'unknown'}`
        );
        mismatch.failureType = 'stale_endpoint';
        mismatch.binding = {
            expectedIdentity,
            liveIdentity,
            expectedSerial,
            liveSerial
        };
        throw mismatch;
    }
}

function buildDefaultEndpoints(router, credential) {
    const endpoints = Array.isArray(router.managementEndpoints) ? [...router.managementEndpoints] : [];
    const vpnHost = stripCidrSuffix(router.vpnIp);
    const localHost = stripCidrSuffix(router.discoveryInfo?.localAddress);
    const openPorts = Array.isArray(router.discoveryInfo?.openPorts) ? router.discoveryInfo.openPorts : [];
    const prefersRemoteManagement = router.connectionMode !== 'management_only' && router.status === 'active';

    if (localHost && openPorts.includes(8728)) {
        endpoints.push({
            id: 'derived-local-api-8728',
            kind: 'local_api',
            host: localHost,
            port: 8728,
            transport: 'api',
            source: 'derived',
            priority: prefersRemoteManagement ? 25 : 1,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'strict',
            authScope: 'unknown',
            health: 'unknown',
            consecutiveFailures: 0
        });
    }

    if (vpnHost) {
        endpoints.push({
            id: 'derived-wireguard-api',
            kind: 'wireguard_management',
            host: vpnHost,
            port: credential?.apiPort || router.apiPort || 8728,
            transport: 'api',
            source: 'derived',
            priority: prefersRemoteManagement ? 1 : 10,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'strict',
            authScope: 'unknown',
            health: 'unknown',
            consecutiveFailures: 0
        });
    }

    if (localHost) {
        endpoints.push({
            id: 'derived-local-api',
            kind: 'local_api',
            host: localHost,
            port: credential?.apiPort || router.apiPort || 8728,
            transport: 'api',
            source: 'derived',
            priority: prefersRemoteManagement ? 35 : 5,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'strict',
            authScope: 'unknown',
            health: 'unknown',
            consecutiveFailures: 0
        });
    }

    if (vpnHost || localHost) {
        endpoints.push({
            id: 'derived-ssh-fallback',
            kind: 'ssh_fallback',
            host: vpnHost || localHost,
            port: 22,
            transport: 'ssh',
            source: 'derived',
            priority: 100,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'disabled',
            authScope: 'unknown',
            health: 'unknown',
            consecutiveFailures: 0
        });
    }

    const unique = new Map();
    for (const endpoint of endpoints) {
        // The current execution client does not implement RouterOS API-SSL yet.
        // Prefer plain API on 8728 when available instead of attempting a broken TLS path.
        if (endpoint.transport === 'api_ssl') {
            continue;
        }
        const key = `${endpoint.kind}:${endpoint.host}:${endpoint.port}:${endpoint.transport}`;
        if (!unique.has(key)) unique.set(key, endpoint);
    }

    return [...unique.values()];
}

function sortEndpoints(endpoints = []) {
    const healthRank = { healthy: 0, degraded: 1, unknown: 2, stale: 3, unreachable: 4 };
    return [...endpoints]
        .filter((endpoint) => endpoint.enabled !== false)
        .sort((a, b) => {
            const healthDiff = (healthRank[a.health] ?? 9) - (healthRank[b.health] ?? 9);
            if (healthDiff !== 0) return healthDiff;
            return (a.priority || 999) - (b.priority || 999);
        });
}

function filterEndpoints(endpoints = [], context = {}) {
    const allowedTransports = Array.isArray(context.allowedTransports)
        ? context.allowedTransports.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];

    if (!allowedTransports.length) {
        return endpoints;
    }

    return endpoints.filter((endpoint) => allowedTransports.includes(String(endpoint.transport || '').toLowerCase()));
}

function resolveManagementEndpoints(router, credential, context = {}) {
    return filterEndpoints(sortEndpoints(buildDefaultEndpoints(router, credential)), context);
}

function classifyFailure(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (/invalid user|cannot log in|authentication failed|permission denied \(publickey|login failed|invalid user name or password/.test(message)) return 'auth_failed';
    if (/invalid time value|invalid value|expected end of command|failure: can't/.test(message)) return 'transport_error';
    if (/no route to host|ehostunreach|econnrefused|timed out|timeout|unreachable/.test(message)) return /timed out|operation timed out|\btimeout\b/.test(message) ? 'timeout' : 'endpoint_unreachable';
    if (/endpoint identity mismatch|identity mismatch/.test(message)) return 'stale_endpoint';
    if (/not enough permissions|permission/.test(message)) return 'permission_denied';
    if (/tls|certificate|hostname/.test(message)) return 'tls_validation_failed';
    return 'transport_error';
}

async function persistEndpointResult(routerId, endpoint, { success, failureType = null }) {
    const set = {};
    const now = new Date();
    set.endpointHealthSummary = success ? 'healthy' : 'degraded';
    set.failureState = success ? {
        current: null,
        firstFailedAt: null,
        lastFailedAt: null,
        lastError: null,
        failingEndpointId: null,
        failingTransport: null
    } : {
        current: failureType,
        lastFailedAt: now,
        failingEndpointId: endpoint.id,
        failingTransport: endpoint.transport
    };

    if (success) {
        set.lastApiSuccessAt = now;
        set.lastApiError = null;
        set.lastApiErrorAt = null;
    } else {
        set.lastApiError = failureType;
        set.lastApiErrorAt = now;
    }

    const router = await MikrotikRouter.findById(routerId).catch(() => null);
    if (!router) {
        return;
    }

    const managementEndpoints = Array.isArray(router.managementEndpoints)
        ? router.managementEndpoints.map((item) => item.toObject ? item.toObject() : { ...item })
        : [];
    const endpointIndex = managementEndpoints.findIndex((item) =>
        item.id === endpoint.id
        || (item.host === endpoint.host && item.port === endpoint.port && item.transport === endpoint.transport)
    );

    if (endpointIndex >= 0) {
        managementEndpoints[endpointIndex] = {
            ...managementEndpoints[endpointIndex],
            health: success ? 'healthy' : 'degraded',
            failureType: success ? null : failureType,
            consecutiveFailures: success
                ? 0
                : Number(managementEndpoints[endpointIndex].consecutiveFailures || 0) + 1,
            lastCheckedAt: now,
            lastSuccessAt: success ? now : managementEndpoints[endpointIndex].lastSuccessAt || null,
            lastFailureAt: success ? managementEndpoints[endpointIndex].lastFailureAt || null : now
        };
    }

    const localHost = stripCidrSuffix(router.discoveryInfo?.localAddress);
    const openPorts = Array.isArray(router.discoveryInfo?.openPorts) ? router.discoveryInfo.openPorts : [];
    const shouldPromotePlainLocalApi =
        success
        && endpoint.transport === 'api'
        && endpoint.port === 8728
        && endpoint.host
        && endpoint.host === localHost
        && openPorts.includes(8728)
        && managementEndpoints.every((item) => item.transport !== 'api' || item.port !== 8728);

    if (shouldPromotePlainLocalApi) {
        managementEndpoints.unshift({
            id: 'import-local-api-8728',
            kind: 'local_api',
            host: endpoint.host,
            port: 8728,
            transport: 'api',
            source: 'derived',
            priority: 1,
            enabled: true,
            allowInsecureTls: false,
            hostValidation: 'strict',
            authScope: 'unknown',
            health: 'healthy',
            failureType: null,
            consecutiveFailures: 0,
            latencyMs: null,
            lastCheckedAt: now,
            lastSuccessAt: now,
            lastFailureAt: null
        });
        set.apiPort = 8728;
    }

    if (managementEndpoints.length) {
        set.managementEndpoints = managementEndpoints
            .filter((item, index, items) => items.findIndex((candidate) =>
                candidate.host === item.host
                && candidate.port === item.port
                && candidate.transport === item.transport
            ) === index)
            .sort((a, b) => (a.priority || 999) - (b.priority || 999));
    }

    set.managementPathObservations = appendPathObservation(router, {
        endpointId: endpoint?.id || null,
        host: endpoint?.host || null,
        port: endpoint?.port || null,
        transport: endpoint?.transport || null,
        pathType: endpoint?.kind === 'wireguard_management'
            ? 'wireguard'
            : (String(endpoint?.kind || '').includes('public') ? 'public' : 'local'),
        operationName: 'router_operation',
        outcome: success ? 'success' : 'failed',
        failureType: success ? null : failureType,
        message: success ? 'Router operation completed' : failureType
    });

    await MikrotikRouter.findByIdAndUpdate(routerId, set).catch(() => undefined);
}

function normalizeSnapshotData(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        const lines = raw.flatMap((entry) => {
            if (!entry) return [];
            if (typeof entry === 'string') return [entry];
            if (typeof entry['=output'] === 'string') return [entry['=output']];
            if (typeof entry.output === 'string') return [entry.output];
            return Object.entries(entry)
                .filter(([key, value]) => typeof value === 'string' && (key.includes('output') || key.includes('message') || key.includes('comment')))
                .map(([, value]) => value);
        }).filter(Boolean);
        return lines.length ? lines.join('\n') : raw;
    }
    return raw;
}

async function maybeCreateSnapshot(routerId, definition, endpoint, credential, actor) {
    if (!definition.snapshot) return null;
    let snapshotData = null;
    try {
        const exportResult = await executeViaEndpoint(endpoint, credential, {
            command: '/export',
            attributes: { terse: 'yes' },
            timeout: 8000
        });
        snapshotData = normalizeSnapshotData(exportResult.records);
    } catch (error) {
        snapshotData = {
            captureError: error?.message || 'Snapshot export failed'
        };
    }

    const normalized = snapshotData == null
        ? null
        : (typeof snapshotData === 'string' ? snapshotData : JSON.stringify(snapshotData));
    return RouterConfigSnapshot.create({
        routerId,
        operationName: definition.scope || definition.commandClass,
        scope: definition.scope || definition.commandClass,
        endpointId: endpoint?.id || null,
        protocol: endpoint?.transport || null,
        data: snapshotData,
        hash: normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : null,
        createdBy: actor || 'system',
        rollbackSupported: ['queues', 'hotspot', 'pppoe', 'firewall', 'routes', 'interfaces'].includes(definition.scope) && Boolean(snapshotData)
    });
}

async function execute(routerId, operationName, context = {}, actorContext = {}) {
    const router = await MikrotikRouter.findById(routerId);
    if (!router) {
        throw new Error('Router not found');
    }

    const authz = authorizeOperation(router, operationName, context);
    const operation = await startOperation({
        routerId,
        actor: actorContext.actor || 'system',
        actorType: actorContext.actorType || 'system',
        requestId: actorContext.requestId || null,
        operationName,
        commandClass: authz.definition.commandClass,
        capabilityRequired: authz.definition.capability,
        dryRun: Boolean(context.dryRun),
        metadata: context.metadata || null
    });

    if (!authz.allowed) {
        log('warn', 'router_operation_blocked', {
            routerId: String(router._id),
            operationName,
            actor: actorContext.actor || 'system',
            actorType: actorContext.actorType || 'system',
            reason: authz.reason,
            ...authz.details
        });
        await finalizeOperation(operation._id, {
            outcome: 'blocked',
            failureType: authz.reason,
            errorMessage: authz.reason,
            durationMs: 0,
            metadata: {
                ...(context.metadata || {}),
                authorization: authz.details
            }
        });
        const blocked = new Error(authz.reason);
        blocked.failureType = authz.reason;
        blocked.authorization = authz.details;
        throw blocked;
    }

    const credential = await getResolvedCredential(router);
    if (!credential) {
        log('warn', 'router_operation_missing_credentials', {
            routerId: String(router._id),
            operationName,
            actor: actorContext.actor || 'system',
            actorType: actorContext.actorType || 'system'
        });
        await finalizeOperation(operation._id, {
            outcome: 'failed',
            failureType: 'auth_failed',
            errorMessage: 'No router credentials configured'
        });
        const err = new Error('No router credentials configured');
        err.failureType = 'auth_failed';
        throw err;
    }

    const endpoints = filterEndpoints(sortEndpoints(buildDefaultEndpoints(router, credential)), context);
    const startedAt = Date.now();
    const transportChain = [];
    let snapshot = null;
    let retries = 0;
    let terminalError = null;

    for (const endpoint of endpoints) {
        try {
            await verifyEndpointBinding(router, endpoint, credential, context);
            snapshot = snapshot || await maybeCreateSnapshot(routerId, authz.definition, endpoint, credential, actorContext.actor);
            const result = await executeViaEndpoint(endpoint, credential, context);

            await persistEndpointResult(routerId, endpoint, { success: true });
            await persistEndpointBindingSuccess(routerId, router, endpoint);
            await finalizeOperation(operation._id, {
                endpointId: endpoint.id,
                endpointKind: endpoint.kind,
                protocol: result.protocol,
                outcome: 'success',
                retries,
                durationMs: Date.now() - startedAt,
                snapshotRef: snapshot?._id || null,
                transportChain
            });
            return result;
        } catch (error) {
            const failureType = error.failureType || classifyFailure(error);
            log('warn', 'router_endpoint_attempt_failed', {
                routerId: String(router._id),
                operationName,
                endpointId: endpoint.id,
                endpointKind: endpoint.kind,
                endpointHost: endpoint.host,
                endpointPort: endpoint.port,
                protocol: endpoint.transport,
                failureType,
                error: error.message || String(error)
            });
            transportChain.push({
                endpointId: endpoint.id,
                protocol: endpoint.transport,
                failureType
            });
            retries += 1;
            await persistEndpointResult(routerId, endpoint, { success: false, failureType });
            if (failureType !== 'stale_endpoint') {
                await updateEndpointHistoryValidation(
                    routerId,
                    (item) => item.validationState === 'pending' && item.nextHost === (endpoint?.host || null),
                    {
                        validationState: 'failed',
                        validationMessage: error?.message || failureType
                    }
                );
            }

            if (failureType === 'stale_endpoint') {
                await persistEndpointBindingMismatch(routerId, router, endpoint, error);
                terminalError = error;
                break;
            }
        }
    }

    const failure = terminalError?.failureType || transportChain[transportChain.length - 1]?.failureType || 'transport_error';
    log('warn', 'router_operation_failed', {
        routerId: String(router._id),
        operationName,
        actor: actorContext.actor || 'system',
        actorType: actorContext.actorType || 'system',
        failureType: failure,
        retries,
        transportChain
    });
    await finalizeOperation(operation._id, {
        outcome: 'failed',
        retries,
        durationMs: Date.now() - startedAt,
        failureType: failure,
        errorMessage: terminalError?.message || failure,
        snapshotRef: snapshot?._id || null,
        transportChain
    });
    const err = terminalError || new Error(failure);
    err.failureType = failure;
    throw err;
}

module.exports = {
    stripCidrSuffix,
    buildDefaultEndpoints,
    resolveManagementEndpoints,
    sortEndpoints,
    classifyFailure,
    execute
};
