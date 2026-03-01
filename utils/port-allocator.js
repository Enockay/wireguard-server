const MikrotikRouter = require('../models/MikrotikRouter');
const { log } = require('../wg-core');

// Port ranges - All 4-digit ports (1000-9999)
const PORT_RANGES = {
    winbox: { start: 1000, end: 3333 },   // 1000-3333 for Winbox
    ssh: { start: 3334, end: 6666 },      // 3334-6666 for SSH
    api: { start: 6667, end: 9999 }       // 6667-9999 for API
};

/**
 * Find next available port in range
 */
async function findAvailablePort(portType) {
    const range = PORT_RANGES[portType];
    if (!range) {
        throw new Error(`Invalid port type: ${portType}`);
    }

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
    PORT_RANGES
};
