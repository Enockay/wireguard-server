const RouterOperation = require('../models/RouterOperation');

async function startOperation({
    routerId,
    actor = 'system',
    actorType = 'system',
    requestId = null,
    operationName,
    commandClass,
    capabilityRequired = null,
    dryRun = false,
    metadata = null
}) {
    return RouterOperation.create({
        routerId,
        actor,
        actorType,
        requestId,
        operationName,
        commandClass,
        capabilityRequired,
        dryRun,
        metadata
    });
}

async function finalizeOperation(operationId, patch = {}) {
    return RouterOperation.findByIdAndUpdate(operationId, patch, { new: true }).catch(() => null);
}

module.exports = {
    startOperation,
    finalizeOperation
};
