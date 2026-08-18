const MikrotikRouter = require('../models/MikrotikRouter');
const { log } = require('../wg-core');
const { getConfig } = require('../config-cache');

const DEFAULT_RANGE_START = 6100;
const DEFAULT_RANGE_END = 7999;
const PORT_TYPES = ['winbox', 'ssh', 'api'];

// The admin-configurable overall range (Settings.proxyPortRangeStart/End,
// default 6100-7999) is split into three equal thirds, one per port type.
// Recomputed on every call rather than cached at module load, since the
// admin can change the range at runtime via PATCH /api/admin/settings and
// refreshConfigCache() takes effect immediately - a stale cached split here
// would silently keep allocating from the old range after that.
function getPortRanges() {
    const start = getConfig('proxyPortRangeStart') || DEFAULT_RANGE_START;
    const end = getConfig('proxyPortRangeEnd') || DEFAULT_RANGE_END;
    const total = end - start + 1;
    const third = Math.floor(total / 3);

    const winboxStart = start;
    const winboxEnd = start + third - 1;
    const sshStart = winboxEnd + 1;
    const sshEnd = sshStart + third - 1;
    const apiStart = sshEnd + 1;
    const apiEnd = end; // remainder (if total isn't divisible by 3) goes to api

    return {
        winbox: { start: winboxStart, end: winboxEnd },
        ssh: { start: sshStart, end: sshEnd },
        api: { start: apiStart, end: apiEnd }
    };
}

/**
 * Find next available port in range
 */
async function findAvailablePort(portType) {
    if (!PORT_TYPES.includes(portType)) {
        throw new Error(`Invalid port type: ${portType}`);
    }
    const range = getPortRanges()[portType];

    // Get all used ports of this type
    const routers = await MikrotikRouter.find({ 
        [`ports.${portType}`]: { $exists: true } 
    }, { [`ports.${portType}`]: 1 });

    const usedPorts = new Set(
        routers.map(r => r.ports[portType]).filter(p => p)
    );

    // Find first available port
    for (let port = range.start; port <= range.end; port++) {
        if (!usedPorts.has(port)) {
            return port;
        }
    }

    throw new Error(`No available ${portType} ports in range ${range.start}-${range.end}`);
}

/**
 * Allocate all three ports for a new router
 */
async function allocatePorts() {
    const [winbox, ssh, api] = await Promise.all([
        findAvailablePort('winbox'),
        findAvailablePort('ssh'),
        findAvailablePort('api')
    ]);

    log('info', 'ports_allocated', { winbox, ssh, api });

    return { winbox, ssh, api };
}

/**
 * Release ports when router is deleted
 */
async function releasePorts(routerId) {
    // Ports are automatically released when router is deleted
    // This function can be used for logging/cleanup if needed
    const router = await MikrotikRouter.findById(routerId);
    if (router) {
        log('info', 'ports_released', { routerId, ports: router.ports });
    }
}

module.exports = {
    allocatePorts,
    releasePorts,
    findAvailablePort,
    getPortRanges
};
