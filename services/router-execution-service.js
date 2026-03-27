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
            kind: 'wireguard_api',
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

function classifyFailure(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (/no route to host|ehostunreach|econnrefused|timed out|timeout|unreachable/.test(message)) return /timeout/.test(message) ? 'timeout' : 'endpoint_unreachable';
    if (/invalid user|cannot log in|authentication failed|permission denied \(publickey|login failed|invalid user name or password/.test(message)) return 'auth_failed';
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

    await MikrotikRouter.findByIdAndUpdate(routerId, set).catch(() => undefined);
}

async function maybeCreateSnapshot(routerId, definition, endpoint, actor) {
    if (!definition.snapshot) return null;
    return RouterConfigSnapshot.create({
        routerId,
        operationName: definition.scope || definition.commandClass,
        scope: definition.scope || definition.commandClass,
        endpointId: endpoint?.id || null,
        protocol: endpoint?.transport || null,
        data: { placeholder: true },
        createdBy: actor || 'system',
        rollbackSupported: ['queues', 'hotspot', 'pppoe', 'firewall', 'routes', 'interfaces'].includes(definition.scope)
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

    const endpoints = sortEndpoints(buildDefaultEndpoints(router, credential));
    const startedAt = Date.now();
    const transportChain = [];
    let snapshot = null;
    let retries = 0;

    for (const endpoint of endpoints) {
        try {
            snapshot = snapshot || await maybeCreateSnapshot(routerId, authz.definition, endpoint, actorContext.actor);

            let result;
            if (endpoint.transport === 'ssh') {
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
                result = {
                    endpoint,
                    records: sshResult.output,
                    data: sshResult.output,
                    protocol: 'ssh'
                };
            } else {
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
                result = {
                    endpoint,
                    records: apiResult.data || [],
                    data: apiResult.data || [],
                    protocol: endpoint.transport
                };
            }

            await persistEndpointResult(routerId, endpoint, { success: true });
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
        }
    }

    const failure = transportChain[transportChain.length - 1]?.failureType || 'transport_error';
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
        errorMessage: failure,
        snapshotRef: snapshot?._id || null,
        transportChain
    });
    const err = new Error(failure);
    err.failureType = failure;
    throw err;
}

module.exports = {
    stripCidrSuffix,
    buildDefaultEndpoints,
    sortEndpoints,
    classifyFailure,
    execute
};
