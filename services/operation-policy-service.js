const COMMAND_CLASS_ORDER = {
    read_only: 1,
    safe_operational: 2,
    service_mutation: 3,
    network_core_mutation: 4,
    bootstrap_mutation: 5
};

const OPERATION_DEFINITIONS = {
    get_system_resource: { commandClass: 'read_only', capability: 'systemRead', snapshot: false, allowRaw: false },
    get_interfaces: { commandClass: 'read_only', capability: 'interfacesRead', snapshot: false, allowRaw: false },
    get_logs: { commandClass: 'read_only', capability: 'logsRead', snapshot: false, allowRaw: false },
    ping: { commandClass: 'read_only', capability: 'systemRead', snapshot: false, allowRaw: false },
    safe_operational: { commandClass: 'safe_operational', capability: 'systemRead', snapshot: false, allowRaw: false },
    reboot: { commandClass: 'safe_operational', capability: 'reboot', snapshot: false, allowRaw: false },
    queue_mutation: { commandClass: 'service_mutation', capability: 'queueWrite', snapshot: true, scope: 'queues', allowRaw: false },
    hotspot_mutation: { commandClass: 'service_mutation', capability: 'hotspotWrite', snapshot: true, scope: 'hotspot', allowRaw: false },
    pppoe_mutation: { commandClass: 'service_mutation', capability: 'pppoeWrite', snapshot: true, scope: 'pppoe', allowRaw: false },
    interfaces_mutation: { commandClass: 'service_mutation', capability: 'interfaceWrite', snapshot: true, scope: 'interfaces', allowRaw: false },
    firewall_mutation: { commandClass: 'network_core_mutation', capability: 'firewallWrite', snapshot: true, scope: 'firewall', allowRaw: false },
    routes_mutation: { commandClass: 'network_core_mutation', capability: 'routesWrite', snapshot: true, scope: 'routes', allowRaw: false },
    bootstrap_mutation: { commandClass: 'bootstrap_mutation', capability: null, snapshot: true, scope: 'bootstrap', allowRaw: false },
    raw_command: { commandClass: 'network_core_mutation', capability: 'rawWrite', snapshot: true, scope: 'raw_command', allowRaw: true, breakGlass: true }
};

function getRouterManagementMode(router) {
    if (!router) return 'fully_managed';
    if (router.managementMode) return router.managementMode;
    return router.connectionMode === 'management_only' ? 'management_only' : 'fully_managed';
}

function classifyRawCommand(command) {
    const normalized = String(command || '').trim().toLowerCase();
    if (!normalized) return 'read_only';

    const mutationTokens = [' add', ' set', ' remove', ' enable', ' disable', ' reset', ' reboot', 'unset', '/system/reboot'];
    if (mutationTokens.some((token) => normalized.includes(token))) {
        if (/\/ip(\/|\s)(firewall|route|address)|\/routing|\/interface|\/tool fetch/.test(normalized)) {
            return 'network_core_mutation';
        }
        return 'service_mutation';
    }

    return 'read_only';
}

function resolveOperationDefinition(operationName, context = {}) {
    if (operationName === 'raw_command') {
        const rawClass = classifyRawCommand(context.command || '');
        return {
            ...OPERATION_DEFINITIONS.raw_command,
            commandClass: rawClass,
            capability: rawClass === 'read_only' ? 'rawRead' : 'rawWrite',
            breakGlass: rawClass !== 'read_only'
        };
    }

    return OPERATION_DEFINITIONS[operationName] || {
        commandClass: 'read_only',
        capability: null,
        snapshot: false,
        allowRaw: false
    };
}

function isClassAllowed(maxClass, actualClass) {
    return (COMMAND_CLASS_ORDER[actualClass] || 0) <= (COMMAND_CLASS_ORDER[maxClass] || 0);
}

function hasCapability(router, capability) {
    if (!capability) return true;
    const capabilities = router?.capabilities || {};

    // Do not hard-block routers that have never completed a capability probe.
    // Newly imported/created routers would otherwise fail every read action
    // because schema defaults initialize booleans to false.
    if (!capabilities.probedAt) {
        return true;
    }

    return capabilities[capability] !== false;
}

function authorizeOperation(router, operationName, context = {}) {
    const definition = resolveOperationDefinition(operationName, context);
    const managementMode = getRouterManagementMode(router);
    const safety = router?.safetyPolicy || {};
    const details = {
        operationName,
        commandClass: definition.commandClass,
        capabilityRequired: definition.capability || null,
        managementMode,
        defaultMaxClass: safety.defaultMaxClass || (managementMode === 'management_only' ? 'safe_operational' : 'network_core_mutation'),
        scope: definition.scope || context.scope || null,
        breakGlassRequired: Boolean(definition.breakGlass),
        breakGlassProvided: Boolean(context.breakGlass),
        approvedScopes: safety.approvedScopes || [],
        capabilitiesProbedAt: router?.capabilities?.probedAt || null
    };

    if (!hasCapability(router, definition.capability)) {
        return {
            allowed: false,
            reason: 'capability_missing',
            definition,
            details
        };
    }

    const maxClass = details.defaultMaxClass;
    if (!isClassAllowed(maxClass, definition.commandClass)) {
        return {
            allowed: false,
            reason: 'unsafe_operation_blocked',
            definition,
            details
        };
    }

    if (managementMode === 'management_only') {
        if (['network_core_mutation', 'bootstrap_mutation'].includes(definition.commandClass) && !safety.allowNetworkCoreWrites) {
            return {
                allowed: false,
                reason: 'unsafe_operation_blocked',
                definition,
                details: {
                    ...details,
                    allowNetworkCoreWrites: Boolean(safety.allowNetworkCoreWrites)
                }
            };
        }

        if (definition.commandClass === 'service_mutation') {
            const scope = definition.scope || context.scope || null;
            if (scope && !(safety.approvedScopes || []).includes(scope)) {
                return {
                    allowed: false,
                    reason: 'unsafe_operation_blocked',
                    definition,
                    details: {
                        ...details,
                        scope
                    }
                };
            }
        }
    }

    if (definition.breakGlass && !context.breakGlass) {
        return {
            allowed: false,
            reason: 'unsafe_operation_blocked',
            definition,
            details
        };
    }

    return {
        allowed: true,
        reason: null,
        definition,
        details
    };
}

module.exports = {
    COMMAND_CLASS_ORDER,
    OPERATION_DEFINITIONS,
    getRouterManagementMode,
    classifyRawCommand,
    resolveOperationDefinition,
    hasCapability,
    authorizeOperation
};
