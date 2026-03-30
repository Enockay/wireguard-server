const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { executeRouterOSCommand } = require('../services/mikrotik-api-service');

const execFileAsync = promisify(execFile);

const DISCOVERY_PORTS = [
    { port: 8291, label: 'winbox' },
    { port: 8728, label: 'api' },
    { port: 8729, label: 'api_ssl' },
    { port: 22, label: 'ssh' },
    { port: 80, label: 'webfig_http' },
    { port: 443, label: 'webfig_https' }
];

function ipToInt(ipAddress) {
    return ipAddress.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function intToIp(value) {
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function netmaskToPrefix(netmask) {
    return netmask
        .split('.')
        .map((octet) => Number(octet).toString(2).padStart(8, '0'))
        .join('')
        .replace(/0+$/, '')
        .length;
}

function parseCidr(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const [address, prefixRaw] = normalized.split('/');
    if (!net.isIPv4(address)) return null;
    const prefix = Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { address, prefix, cidr: `${address}/${prefix}` };
}

function parseConfiguredCidrs(value) {
    return String(value || '')
        .split(',')
        .map((item) => parseCidr(item))
        .filter(Boolean)
        .map((item) => item.cidr);
}

function isLikelyContainerInterface(name, item = {}) {
    const normalizedName = String(name || '').trim().toLowerCase();
    const mac = String(item.mac || '').trim().toLowerCase();

    if (/^(docker|br-|veth|cni|flannel|virbr|podman)/.test(normalizedName)) {
        return true;
    }

    if (mac.startsWith('02:42:')) {
        return true;
    }

    return false;
}

function getLocalDiscoveryCidrs() {
    const preferred = parseConfiguredCidrs(process.env.ROUTER_DISCOVERY_PREFERRED_SUBNETS || process.env.ROUTER_DISCOVERY_ALLOWED_SUBNETS);
    if (preferred.length) {
        return [...new Set(preferred)];
    }

    const excluded = new Set(parseConfiguredCidrs(process.env.ROUTER_DISCOVERY_EXCLUDE_SUBNETS));
    const interfaces = os.networkInterfaces();
    const discovered = [];

    Object.entries(interfaces).forEach(([name, items]) => {
        (items || []).forEach((item) => {
            if (!item || item.family !== 'IPv4' || item.internal || !item.address || !item.netmask) return;
            if (item.address.startsWith('127.') || item.address.startsWith('169.254.')) return;
            if (isLikelyContainerInterface(name, item)) return;
            const prefix = netmaskToPrefix(item.netmask);
            const cidr = `${item.address}/${prefix}`;
            if (excluded.has(cidr)) return;
            discovered.push(cidr);
        });
    });

    return [...new Set(discovered)];
}

function expandCidrTargets(cidr, maxHosts = 254) {
    const parsed = parseCidr(cidr);
    if (!parsed) return { subnet: null, addresses: [], truncated: false };

    const hostBits = 32 - parsed.prefix;
    const totalHosts = hostBits <= 1 ? 1 : (2 ** hostBits) - 2;
    const networkMask = parsed.prefix === 0 ? 0 : (0xffffffff << hostBits) >>> 0;
    const networkAddress = ipToInt(parsed.address) & networkMask;
    const firstHost = hostBits <= 1 ? networkAddress : networkAddress + 1;
    const availableHosts = Math.max(1, totalHosts);
    const count = Math.min(availableHosts, maxHosts);
    const addresses = [];

    for (let index = 0; index < count; index += 1) {
        addresses.push(intToIp(firstHost + index));
    }

    return {
        subnet: parsed.cidr,
        addresses,
        truncated: availableHosts > maxHosts
    };
}

function serviceLabelForPort(port) {
    return DISCOVERY_PORTS.find((entry) => entry.port === port)?.label || `port_${port}`;
}

function probePort(ipAddress, port, timeout = 350) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (open) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(open);
        };

        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, ipAddress);
    });
}

async function lookupNeighbor(ipAddress) {
    const commands = [
        ['ip', ['neigh', 'show', ipAddress]],
        ['arp', ['-n', ipAddress]]
    ];

    for (const [binary, args] of commands) {
        try {
            const { stdout } = await execFileAsync(binary, args, { timeout: 1000 });
            const normalized = String(stdout || '');
            const macMatch = normalized.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
            if (macMatch) {
                return {
                    macAddress: macMatch[1].toLowerCase(),
                    vendor: null
                };
            }
        } catch (error) {
            continue;
        }
    }

    return {
        macAddress: null,
        vendor: null
    };
}

async function scanIpAddress(ipAddress, subnet, source = 'server') {
    const portChecks = await Promise.all(DISCOVERY_PORTS.map(async ({ port }) => ({
        port,
        open: await probePort(ipAddress, port)
    })));
    const openPorts = portChecks.filter((entry) => entry.open).map((entry) => entry.port);
    if (!openPorts.length) return null;

    const neighbor = await lookupNeighbor(ipAddress);
    const detectedServices = openPorts.map(serviceLabelForPort);
    const likelyMikrotik = openPorts.includes(8291) || openPorts.includes(8728) || openPorts.includes(8729);
    const confidence = likelyMikrotik ? 0.92 : (openPorts.includes(22) ? 0.55 : 0.35);

    return {
        ipAddress,
        subnet,
        hostname: null,
        macAddress: neighbor.macAddress,
        vendor: neighbor.vendor,
        openPorts,
        detectedServices,
        isLikelyMikrotik: likelyMikrotik,
        confidence,
        discoverySource: source,
        scannedAt: new Date()
    };
}

async function runLimited(items, limit, task) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const currentIndex = index;
            index += 1;
            const result = await task(items[currentIndex], currentIndex);
            if (result) {
                results.push(result);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker()));
    return results;
}

async function scanSubnets({ subnets, source = 'server', maxHostsPerSubnet = 254, concurrency = 48 }) {
    const normalized = (subnets || []).map((item) => String(item || '').trim()).filter(Boolean);
    const scannedSubnets = [];
    let truncated = false;
    let hostCountScanned = 0;
    const candidates = [];

    for (const subnet of normalized) {
        const expanded = expandCidrTargets(subnet, maxHostsPerSubnet);
        if (!expanded.subnet) continue;
        scannedSubnets.push(expanded.subnet);
        truncated = truncated || expanded.truncated;
        hostCountScanned += expanded.addresses.length;

        const subnetCandidates = await runLimited(expanded.addresses, concurrency, (ipAddress) => scanIpAddress(ipAddress, expanded.subnet, source));
        candidates.push(...subnetCandidates);
    }

    return {
        scannedSubnets,
        hostCountScanned,
        truncated,
        truncatedReason: truncated ? `Scan limited to ${maxHostsPerSubnet} hosts per subnet for safety` : null,
        candidates: candidates.sort((left, right) => right.confidence - left.confidence)
    };
}

function parseRouterOSKeyValue(output) {
    const result = {};
    String(output || '')
        .split('\n')
        .map((line) => line.trim())
        .forEach((line) => {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (!match) return;
            const key = match[1].trim();
            const normalizedKey = key.replace(/\s+/g, '-').toLowerCase();
            result[normalizedKey] = match[2].trim();
        });
    return result;
}

function parseInterfaceSummary(output) {
    const lines = String(output || '').split('\n');
    return lines
        .map((line) => line.trim())
        .filter((line) => /^\d+\s/.test(line))
        .map((line) => {
            const nameMatch = line.match(/\bname="?([^"\s]+)"?/i);
            const typeMatch = line.match(/\btype="?([^"\s]+)"?/i);
            const disabledMatch = line.match(/\bdisabled=(yes|no|true|false)\b/i);
            const runningMatch = line.match(/\brunning=(yes|no|true|false)\b/i);
            const commentMatch = line.match(/\bcomment="?([^"]*)"?$/i);
            return {
                name: nameMatch?.[1] || line.replace(/^\d+\s+/, '').split(/\s+/)[0] || 'unknown',
                type: typeMatch?.[1] || 'unknown',
                running: runningMatch ? ['yes', 'true'].includes(runningMatch[1].toLowerCase()) : /\bR\b/.test(line),
                disabled: disabledMatch ? ['yes', 'true'].includes(disabledMatch[1].toLowerCase()) : false,
                comment: commentMatch?.[1] || ''
            };
        });
}

function parseMajorVersion(version) {
    const match = String(version || '').trim().match(/^(\d+)/);
    return match ? Number(match[1]) : null;
}

async function verifyRouterCandidate({ ipAddress, username, password, openPorts = [] }) {
    if (!ipAddress || !username || !password) {
        return {
            success: false,
            error: 'IP address, username, and password are required',
            verification: {
                status: 'failed',
                method: 'ssh',
                metadata: null,
                readiness: {
                    status: 'blocked',
                    reasons: ['Missing credentials'],
                    apiReachable: openPorts.includes(8728) || openPorts.includes(8729),
                    sshReachable: openPorts.includes(22),
                    winboxReachable: openPorts.includes(8291),
                    wireGuardReady: false
                }
            }
        };
    }

    const identityResult = await executeRouterOSCommand(ipAddress, '/system identity print', username, password, 5000);
    if (!identityResult.success) {
        const sshReason = identityResult.code === 'ESSHPASS'
            ? 'Password-based SSH verification is unavailable in the API environment'
            : identityResult.isAuthError
                ? 'Invalid credentials'
                : 'SSH unreachable or disabled';
        return {
            success: false,
            error: identityResult.code === 'ESSHPASS'
                ? 'SSH password verification is not available on this server. Install sshpass or use RouterOS API verification.'
                : identityResult.isAuthError
                    ? 'Invalid router credentials'
                    : 'Could not connect to router via SSH',
            verification: {
                status: identityResult.isAuthError ? 'failed' : 'unsupported',
                method: 'ssh',
                metadata: null,
                readiness: {
                    status: 'blocked',
                    reasons: [sshReason],
                    apiReachable: openPorts.includes(8728) || openPorts.includes(8729),
                    sshReachable: false,
                    winboxReachable: openPorts.includes(8291),
                    wireGuardReady: false
                }
            }
        };
    }

    const [resourceResult, routerboardResult, interfaceResult] = await Promise.all([
        executeRouterOSCommand(ipAddress, '/system resource print', username, password, 5000),
        executeRouterOSCommand(ipAddress, '/system routerboard print', username, password, 5000),
        executeRouterOSCommand(ipAddress, '/interface print terse', username, password, 5000)
    ]);

    const identityInfo = parseRouterOSKeyValue(identityResult.output);
    const resourceInfo = parseRouterOSKeyValue(resourceResult.output);
    const routerboardInfo = parseRouterOSKeyValue(routerboardResult.output);
    const interfaces = interfaceResult.success ? parseInterfaceSummary(interfaceResult.output) : [];
    const version = resourceInfo.version || routerboardInfo['current-firmware'] || null;
    const majorVersion = parseMajorVersion(version);
    const wireGuardReady = majorVersion !== null ? majorVersion >= 7 : false;
    const readinessReasons = [];

    if (!wireGuardReady) readinessReasons.push('RouterOS version does not appear to support WireGuard');
    if (!openPorts.includes(22)) readinessReasons.push('SSH port is not open on the discovered candidate');

    return {
        success: true,
        verification: {
            status: 'verified',
            method: 'ssh',
            metadata: {
                identity: identityInfo.name || identityInfo.identity || null,
                boardName: routerboardInfo['board-name'] || null,
                serialNumber: routerboardInfo['serial-number'] || null,
                routerosVersion: version,
                firmware: routerboardInfo['current-firmware'] || null,
                model: routerboardInfo.model || null,
                macAddress: null,
                interfaces,
                interfaceCount: interfaces.length,
                raw: {
                    identity: identityInfo,
                    resource: resourceInfo,
                    routerboard: routerboardInfo
                }
            },
            readiness: {
                status: readinessReasons.length ? 'warning' : 'ready',
                reasons: readinessReasons,
                apiReachable: openPorts.includes(8728) || openPorts.includes(8729),
                sshReachable: true,
                winboxReachable: openPorts.includes(8291),
                wireGuardReady
            }
        }
    };
}

async function verifyRouterCandidateApi({ ipAddress, username, password, openPorts = [], port = 8728 }) {
    const { executeRouterOsApiCommand } = require('./routeros-api-client');
    const commands = await Promise.all([
        executeRouterOsApiCommand({ host: ipAddress, port, username, password, command: '/system/identity/print' }),
        executeRouterOsApiCommand({ host: ipAddress, port, username, password, command: '/system/resource/print' }),
        executeRouterOsApiCommand({ host: ipAddress, port, username, password, command: '/system/routerboard/print' }),
        executeRouterOsApiCommand({ host: ipAddress, port, username, password, command: '/interface/print' })
    ]);

    const [identityResult, resourceResult, routerboardResult, interfaceResult] = commands;
    if (!identityResult.success) {
        return {
            success: false,
            error: identityResult.isAuthError ? 'Invalid router credentials' : 'Could not connect to router via RouterOS API',
            verification: {
                status: identityResult.isAuthError ? 'failed' : 'unsupported',
                method: 'api',
                metadata: null,
                readiness: {
                    status: 'blocked',
                    reasons: [identityResult.isAuthError ? 'Invalid API credentials' : 'RouterOS API unreachable or disabled'],
                    apiReachable: false,
                    sshReachable: openPorts.includes(22),
                    winboxReachable: openPorts.includes(8291),
                    wireGuardReady: false
                }
            }
        };
    }

    const identity = identityResult.data?.[0] || {};
    const resource = resourceResult.data?.[0] || {};
    const routerboard = routerboardResult.data?.[0] || {};
    const interfaces = (interfaceResult.data || []).map((item) => ({
        name: item.name || 'unknown',
        type: item.type || 'unknown',
        running: item.running === 'true' || item.running === 'yes',
        disabled: item.disabled === 'true' || item.disabled === 'yes',
        comment: item.comment || ''
    }));
    const version = resource.version || routerboard['current-firmware'] || null;
    const majorVersion = parseMajorVersion(version);
    const wireGuardReady = majorVersion !== null ? majorVersion >= 7 : false;
    const readinessReasons = [];

    if (!wireGuardReady) readinessReasons.push('RouterOS version does not appear to support WireGuard');

    return {
        success: true,
        verification: {
            status: 'verified',
            method: 'api',
            metadata: {
                identity: identity.name || null,
                boardName: routerboard['board-name'] || null,
                serialNumber: routerboard['serial-number'] || null,
                routerosVersion: version,
                firmware: routerboard['current-firmware'] || null,
                model: routerboard.model || null,
                macAddress: null,
                interfaces,
                interfaceCount: interfaces.length,
                raw: {
                    identity,
                    resource,
                    routerboard
                }
            },
            readiness: {
                status: readinessReasons.length ? 'warning' : 'ready',
                reasons: readinessReasons,
                apiReachable: true,
                sshReachable: openPorts.includes(22),
                winboxReachable: openPorts.includes(8291),
                wireGuardReady
            }
        }
    };
}

module.exports = {
    DISCOVERY_PORTS,
    getLocalDiscoveryCidrs,
    parseCidr,
    scanSubnets,
    verifyRouterCandidate,
    verifyRouterCandidateApi
};
