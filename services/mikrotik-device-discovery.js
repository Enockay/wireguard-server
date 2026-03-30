/**
 * MikroTik Device Discovery Integration
 * This service discovers connected devices from MikroTik routers
 * and persists them for topology views.
 */

const deviceTopologyService = require('./device-topology-service');
const { execute: executeRouterOperation } = require('./router-execution-service');

const DEFAULT_TIMEOUT_MS = 3500;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 7000;
const DEFAULT_DISCOVERY_SOURCES = ['wireless', 'arp', 'bgp', 'neighbor', 'wireguard', 'pppoe', 'hotspot'];

function toArray(result) {
    if (Array.isArray(result?.records)) return result.records;
    if (Array.isArray(result?.data)) return result.data;
    return [];
}

function asNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
}

function parseRouterOsDate(value) {
    const normalized = firstNonEmpty(value);
    if (!normalized) return null;

    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        const normalized = String(value).trim();
        if (normalized) return normalized;
    }
    return null;
}

async function executeDiscoveryCommand(routerId, command, attributes, actorContext, metadata = {}) {
    const boundedTimeout = Math.max(
        MIN_TIMEOUT_MS,
        Math.min(MAX_TIMEOUT_MS, Number(metadata.timeoutMs) || DEFAULT_TIMEOUT_MS)
    );
    return executeRouterOperation(
        routerId,
        'topology_discovery',
        {
            command,
            attributes: attributes || {},
            timeout: boundedTimeout,
            allowedTransports: ['api'],
            metadata: {
                discoveryCommand: command,
                timeoutMs: boundedTimeout,
                ...metadata
            }
        },
        actorContext
    );
}

async function executeFirstSuccessful(routerId, candidates, actorContext, metadata = {}) {
    const attempts = [];

    for (const candidate of candidates) {
        try {
            const result = await executeDiscoveryCommand(
                routerId,
                candidate.command,
                candidate.attributes,
                actorContext,
                {
                    ...metadata,
                    source: metadata.source || candidate.source || null,
                    fallbackCommand: candidate.command
                }
            );

            return {
                command: candidate.command,
                data: toArray(result),
                attempts
            };
        } catch (error) {
            attempts.push({
                command: candidate.command,
                error: error.message || 'unknown error'
            });
        }
    }

    const finalError = new Error(attempts[attempts.length - 1]?.error || 'All discovery commands failed');
    finalError.attempts = attempts;
    throw finalError;
}

async function persistDiscoveredDevices(routerId, source, devices) {
    const identityKeys = [];
    const persisted = [];

    for (const device of devices) {
        const saved = await deviceTopologyService.upsertConnectedDevice(routerId, {
            ...device,
            discoverySource: source
        });

        if (saved?.identityKey) {
            identityKeys.push(saved.identityKey);
        }

        persisted.push(saved);
    }

    await deviceTopologyService.markMissingDevicesOffline(routerId, source, identityKeys, new Date());

    return persisted;
}

function buildDiscoveryResult(source, devices, options = {}) {
    return {
        source,
        devices,
        count: devices.length,
        status: options.status || 'completed',
        command: options.command || null,
        attempts: options.attempts || [],
        warnings: options.warnings || [],
        error: options.error || null
    };
}

async function discoverWirelessDevices(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [
                { command: '/interface/wireless/registration-table/print' },
                { command: '/interface/wifi/registration-table/print' }
            ],
            actorContext,
            { source: 'wireless', timeoutMs: actorContext?.timeoutMs }
        );

        const devices = data
            .filter((station) => firstNonEmpty(station['mac-address'], station.macAddress))
            .map((station) => ({
                deviceId: firstNonEmpty(station['mac-address'], station.macAddress),
                deviceName: firstNonEmpty(
                    station.comment,
                    station['comment'],
                    station['host-name'],
                    station['host-name'],
                    `Station ${firstNonEmpty(station['mac-address'], station.macAddress)}`
                ),
                deviceType: 'client',
                ipAddress: firstNonEmpty(station['last-ip'], station['ip-address'], station.address, '0.0.0.0'),
                macAddress: firstNonEmpty(station['mac-address'], station.macAddress),
                interfaceName: firstNonEmpty(station.interface, station['interface-name']),
                signal: asNumber(station.signal),
                bandwidth: asNumber(station['tx-rate']) || asNumber(station['rx-rate']) || 0,
                isOnline: true,
                manufacturer: firstNonEmpty(station.comment?.split('-')?.[0], 'Unknown'),
                lastConnected: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'wireless', devices);
        return buildDiscoveryResult('wireless', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('wireless', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverArpDevices(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [{ command: '/ip/arp/print' }],
            actorContext,
            { source: 'arp', timeoutMs: actorContext?.timeoutMs }
        );

        const devices = data
            .filter((entry) => firstNonEmpty(entry['mac-address'], entry.address))
            .map((entry) => ({
                deviceId: firstNonEmpty(entry['mac-address'], entry.address),
                deviceName: firstNonEmpty(entry.comment, `ARP ${entry.address}`),
                deviceType: 'unknown',
                ipAddress: firstNonEmpty(entry.address, '0.0.0.0'),
                macAddress: firstNonEmpty(entry['mac-address']),
                interfaceName: firstNonEmpty(entry.interface),
                isOnline: !asBoolean(entry.disabled),
                lastSeen: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'arp', devices);
        return buildDiscoveryResult('arp', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('arp', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverRouterPeers(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [
                { command: '/routing/bgp/session/print' },
                { command: '/routing/bgp/peer/print' }
            ],
            actorContext,
            { source: 'bgp', timeoutMs: actorContext?.timeoutMs }
        );

        const devices = data
            .filter((peer) => firstNonEmpty(peer.remoteAddress, peer.address, peer['remote.address']))
            .map((peer) => ({
                deviceId: firstNonEmpty(peer.remoteAddress, peer.address, peer['remote.address']),
                deviceName: firstNonEmpty(peer.name, peer.comment, `BGP Peer ${firstNonEmpty(peer.remoteAddress, peer.address, peer['remote.address'])}`),
                deviceType: 'router',
                ipAddress: firstNonEmpty(peer.remoteAddress, peer.address, peer['remote.address']),
                publicKey: firstNonEmpty(peer['tcp-md5-key']),
                isOnline: !asBoolean(peer.disabled) && !/idle|connect|active/i.test(String(peer.state || peer.status || '')),
                lastConnected: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'bgp', devices);
        return buildDiscoveryResult('bgp', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('bgp', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverLldpNeighbors(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [
                { command: '/ip/neighbor/print' },
                { command: '/interface/ethernet/switch/lldp/neighbor/print' }
            ],
            actorContext,
            { source: 'neighbor', timeoutMs: actorContext?.timeoutMs }
        );

        const devices = data
            .filter((neighbor) => firstNonEmpty(neighbor.address, neighbor['mac-address'], neighbor['device-id'], neighbor.identity))
            .map((neighbor) => ({
                deviceId: firstNonEmpty(neighbor['device-id'], neighbor.identity, neighbor.address, neighbor['mac-address']),
                deviceName: firstNonEmpty(neighbor['device-name'], neighbor.identity, neighbor['system-name'], neighbor.address),
                deviceType: 'router',
                ipAddress: firstNonEmpty(neighbor.address, neighbor['management-address'], '0.0.0.0'),
                macAddress: firstNonEmpty(neighbor['mac-address']),
                manufacturer: firstNonEmpty(neighbor.platform, neighbor['system-description'], 'Unknown'),
                model: firstNonEmpty(neighbor['device-description'], neighbor.board, neighbor.version),
                interfaceName: firstNonEmpty(neighbor.interface),
                isOnline: true,
                lastSeen: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'neighbor', devices);
        return buildDiscoveryResult('neighbor', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('neighbor', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverWireGuardPeers(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [{ command: '/interface/wireguard/peers/print' }],
            actorContext,
            { source: 'wireguard', timeoutMs: actorContext?.timeoutMs }
        );

        const devices = data
            .filter((peer) => firstNonEmpty(peer['public-key']))
            .map((peer) => {
                const tx = asNumber(peer['tx']) || 0;
                const rx = asNumber(peer['rx']) || 0;
                const lastConnected = parseRouterOsDate(firstNonEmpty(peer['last-handshake'], peer['last-handshake-time']));
                return {
                    deviceId: firstNonEmpty(peer['public-key']),
                    deviceName: firstNonEmpty(peer.comment, `WG Peer ${String(peer['public-key']).slice(0, 8)}`),
                    deviceType: 'client',
                    ipAddress: firstNonEmpty(peer['current-endpoint-address'], peer['allowed-address'], '0.0.0.0'),
                    publicKey: firstNonEmpty(peer['public-key']),
                    interfaceName: firstNonEmpty(peer.interface),
                    isOnline: Boolean(lastConnected),
                    lastConnected,
                    bandwidth: (tx + rx) / 1024 / 1024
                };
            });

        const persisted = await persistDiscoveredDevices(routerId, 'wireguard', devices);
        return buildDiscoveryResult('wireguard', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('wireguard', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverPppoeClients(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [
                { command: '/ppp/active/print' },
                { command: '/interface/pppoe-server/monitor', attributes: { once: 'true' } }
            ],
            actorContext,
            { source: 'pppoe', timeoutMs: actorContext?.timeoutMs }
        );

        const clients = data
            .filter((session) => {
                const service = String(session.service || '').toLowerCase();
                return service === 'pppoe' || firstNonEmpty(session.name, session['caller-id'], session.address);
            })
            .map((session) => ({
                deviceId: firstNonEmpty(session.name, session['caller-id'], session.address),
                deviceName: firstNonEmpty(session.comment, session.name, session['caller-id']),
                deviceType: 'client',
                ipAddress: firstNonEmpty(session.address, session['remote-address'], session['client-address'], '0.0.0.0'),
                macAddress: firstNonEmpty(session['caller-id']),
                interfaceName: firstNonEmpty(session.service, session.interface, 'pppoe'),
                isOnline: !asBoolean(session.disabled),
                lastConnected: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'pppoe', clients);
        return buildDiscoveryResult('pppoe', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('pppoe', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

async function discoverHotspotClients(routerId, actorContext) {
    try {
        const { data, command, attempts } = await executeFirstSuccessful(
            routerId,
            [{ command: '/ip/hotspot/active/print' }],
            actorContext,
            { source: 'hotspot', timeoutMs: actorContext?.timeoutMs }
        );

        const clients = data
            .filter((session) => firstNonEmpty(session.address, session.user, session['mac-address']))
            .map((session) => ({
                deviceId: firstNonEmpty(session['mac-address'], session.user, session.address),
                deviceName: firstNonEmpty(session['host-name'], session.user, session.comment, session.address),
                deviceType: 'client',
                ipAddress: firstNonEmpty(session.address, '0.0.0.0'),
                macAddress: firstNonEmpty(session['mac-address']),
                interfaceName: firstNonEmpty(session.server, session.interface, 'hotspot'),
                isOnline: true,
                lastConnected: new Date()
            }));

        const persisted = await persistDiscoveredDevices(routerId, 'hotspot', clients);
        return buildDiscoveryResult('hotspot', persisted, { command, attempts });
    } catch (error) {
        return buildDiscoveryResult('hotspot', [], {
            status: 'failed',
            attempts: error.attempts || [],
            error: error.message
        });
    }
}

function normalizeDiscoveryOptions(options = {}) {
    const timeoutMs = Math.max(
        MIN_TIMEOUT_MS,
        Math.min(MAX_TIMEOUT_MS, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
    );
    const requestedSources = Array.isArray(options.sources)
        ? options.sources.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
    const sources = requestedSources.length
        ? DEFAULT_DISCOVERY_SOURCES.filter((source) => requestedSources.includes(source))
        : DEFAULT_DISCOVERY_SOURCES;

    return {
        timeoutMs,
        sources
    };
}

async function runFullDeviceDiscovery(routerId, actorContext, options = {}) {
    const startedAt = new Date();
    const startTime = Date.now();
    const normalizedOptions = normalizeDiscoveryOptions(options);
    const scopedActorContext = {
        ...actorContext,
        timeoutMs: normalizedOptions.timeoutMs
    };
    const sourceHandlers = {
        wireless: () => discoverWirelessDevices(routerId, scopedActorContext),
        arp: () => discoverArpDevices(routerId, scopedActorContext),
        bgp: () => discoverRouterPeers(routerId, scopedActorContext),
        neighbor: () => discoverLldpNeighbors(routerId, scopedActorContext),
        wireguard: () => discoverWireGuardPeers(routerId, scopedActorContext),
        pppoe: () => discoverPppoeClients(routerId, scopedActorContext),
        hotspot: () => discoverHotspotClients(routerId, scopedActorContext)
    };

    const scans = await Promise.all(normalizedOptions.sources.map((source) => sourceHandlers[source]()));

    const discoveries = {};
    const errors = [];
    const warnings = [];
    let completedSources = 0;
    let failedSources = 0;

    for (const scan of scans) {
        discoveries[scan.source] = scan.count;
        if (scan.status === 'failed') {
            failedSources += 1;
            errors.push({
                source: scan.source,
                error: scan.error,
                attempts: scan.attempts
            });
            continue;
        }

        completedSources += 1;
        if (Array.isArray(scan.warnings) && scan.warnings.length > 0) {
            warnings.push(...scan.warnings.map((warning) => ({ source: scan.source, warning })));
        }
    }

    const status = failedSources === scans.length
        ? 'failed'
        : failedSources > 0
            ? 'partial'
            : 'completed';

    return {
        status,
        startedAt,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
        routerId,
        timeoutMs: normalizedOptions.timeoutMs,
        sources: normalizedOptions.sources,
        discoveries,
        completedSources,
        failedSources,
        totalDevicesDiscovered: Object.values(discoveries).reduce((total, count) => total + count, 0),
        warnings,
        errors
    };
}

function schedulePeriodicDiscovery(routerId, intervalMinutes = 30) {
    const intervalMs = intervalMinutes * 60 * 1000;

    setInterval(async () => {
        try {
            await runFullDeviceDiscovery(routerId, { actor: 'system', reason: 'Periodic discovery' });
        } catch (error) {
            console.error('[PERIODIC DISCOVERY] Failed:', error);
        }
    }, intervalMs);
}

module.exports = {
    discoverWirelessDevices,
    discoverArpDevices,
    discoverRouterPeers,
    discoverLldpNeighbors,
    discoverWireGuardPeers,
    discoverPppoeClients,
    discoverHotspotClients,
    runFullDeviceDiscovery,
    schedulePeriodicDiscovery
};
