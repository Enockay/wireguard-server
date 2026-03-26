const net = require('net');
const MikrotikRouter = require('../models/MikrotikRouter');
const RouterLease = require('../models/RouterLease');
const DownstreamRouterDiscoveryRun = require('../models/DownstreamRouterDiscoveryRun');
const { execute: executeRouterOperation } = require('./router-execution-service');
const { log } = require('../wg-core');

const DISCOVERY_JOB_TYPE = 'downstream_mikrotik_discovery';
const DEFAULT_OPTIONS = {
    enableNeighborDiscovery: true,
    enableRouteInspection: true,
    enableSubnetProbe: true,
    maxProbeTargets: 24,
    timeoutMs: 2500,
    scanDepth: 1,
    allowedSubnetCidrs: [],
    excludeCidrs: [],
    portPreferences: {
        api: 8728,
        ssh: 22,
        winbox: 8291
    }
};

function ipv4ToInt(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) return null;
        result = (result << 8) + numeric;
    }
    return result >>> 0;
}

function intToIpv4(value) {
    const normalized = Number(value) >>> 0;
    return [
        (normalized >>> 24) & 255,
        (normalized >>> 16) & 255,
        (normalized >>> 8) & 255,
        normalized & 255
    ].join('.');
}

function parseCidr(value) {
    const normalized = String(value || '').trim();
    const match = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    if (!match) return null;
    const ip = ipv4ToInt(match[1]);
    const prefix = Number(match[2]);
    if (ip == null || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
    const network = (ip & mask) >>> 0;
    const broadcast = prefix === 32 ? network : (network | (~mask >>> 0)) >>> 0;
    return {
        cidr: `${intToIpv4(network)}/${prefix}`,
        ip: match[1],
        prefix,
        network,
        broadcast,
        mask
    };
}

function stripCidr(value) {
    return String(value || '').trim().split('/')[0].trim();
}

function isPrivateInfrastructureCidr(cidr) {
    const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!parsed) return false;
    const ip = parsed.network;
    return (
        (ip >= ipv4ToInt('10.0.0.0') && ip <= ipv4ToInt('10.255.255.255')) ||
        (ip >= ipv4ToInt('172.16.0.0') && ip <= ipv4ToInt('172.31.255.255')) ||
        (ip >= ipv4ToInt('192.168.0.0') && ip <= ipv4ToInt('192.168.255.255')) ||
        (ip >= ipv4ToInt('100.64.0.0') && ip <= ipv4ToInt('100.127.255.255'))
    );
}

function cidrContains(cidr, ipAddress) {
    const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    const ip = ipv4ToInt(stripCidr(ipAddress));
    if (!parsed || ip == null) return false;
    return ip >= parsed.network && ip <= parsed.broadcast;
}

function normalizeOptions(options = {}) {
    const merged = {
        ...DEFAULT_OPTIONS,
        ...options,
        portPreferences: {
            ...DEFAULT_OPTIONS.portPreferences,
            ...(options.portPreferences || {})
        }
    };

    merged.maxProbeTargets = Math.max(1, Math.min(128, Number(merged.maxProbeTargets) || DEFAULT_OPTIONS.maxProbeTargets));
    merged.timeoutMs = Math.max(500, Math.min(10000, Number(merged.timeoutMs) || DEFAULT_OPTIONS.timeoutMs));
    merged.scanDepth = Math.max(1, Math.min(2, Number(merged.scanDepth) || DEFAULT_OPTIONS.scanDepth));
    merged.allowedSubnetCidrs = Array.isArray(merged.allowedSubnetCidrs) ? merged.allowedSubnetCidrs.map((item) => String(item).trim()).filter(Boolean) : [];
    merged.excludeCidrs = Array.isArray(merged.excludeCidrs) ? merged.excludeCidrs.map((item) => String(item).trim()).filter(Boolean) : [];
    return merged;
}

function buildEvidenceString(label, value) {
    return value ? `${label}:${value}` : label;
}

async function acquireDiscoveryLease(routerId, ownerId) {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await RouterLease.deleteMany({ routerId, jobType: DISCOVERY_JOB_TYPE, expiresAt: { $lt: new Date() } });

    try {
        return await RouterLease.create({
            routerId,
            jobType: DISCOVERY_JOB_TYPE,
            ownerId,
            expiresAt
        });
    } catch (error) {
        if (error?.code === 11000) return null;
        throw error;
    }
}

async function releaseDiscoveryLease(routerId) {
    await RouterLease.deleteMany({ routerId, jobType: DISCOVERY_JOB_TYPE }).catch(() => undefined);
}

async function safeExecute(routerId, command, attributes, warnings, actorContext, metadata = {}) {
    try {
        const result = await executeRouterOperation(routerId, 'topology_discovery', {
            command,
            attributes: attributes || {},
            timeout: metadata.timeoutMs || DEFAULT_OPTIONS.timeoutMs,
            metadata
        }, actorContext);
        return Array.isArray(result.records) ? result.records : (Array.isArray(result.data) ? result.data : []);
    } catch (error) {
        warnings.push(`Command ${command} failed: ${error.message || 'unknown error'}`);
        return [];
    }
}

function extractSourceIdentity(records = []) {
    const first = records[0] || {};
    return {
        identity: first.name || first.identity || null,
        version: first.version || null
    };
}

function buildParentContext(router, identityRecords, resourceRecords) {
    const source = extractSourceIdentity(identityRecords.length ? identityRecords : resourceRecords);
    return {
        routerId: String(router._id),
        routerName: router.name || null,
        tunnelIp: stripCidr(router.vpnIp) || stripCidr(router.discoveryInfo?.localAddress) || null,
        identity: source.identity || router.name || null,
        version: source.version || router.routerosVersion || null
    };
}

function normalizeNeighborCandidate(record = {}, parentContext) {
    const address = stripCidr(record.address || record['address4'] || record['primary-address']);
    if (!ipv4ToInt(address)) return null;

    const vendorHint = `${record.identity || ''} ${record.platform || ''} ${record.version || ''} ${record.board || ''}`.toLowerCase();
    const explicitMikrotik = /mikrotik|routeros/.test(vendorHint);
    const confidence = explicitMikrotik || record.board || record.version ? 'high' : 'medium';

    return {
        ipAddress: address,
        identity: record.identity || record.identityName || null,
        platform: record.platform || 'RouterOS',
        vendor: explicitMikrotik ? 'MikroTik' : (record.platform || null),
        confidence,
        evidence: [
            buildEvidenceString('neighbor_identity', record.identity || null),
            buildEvidenceString('neighbor_platform', record.platform || null),
            buildEvidenceString('neighbor_version', record.version || null),
            buildEvidenceString('neighbor_interface', record.interface || record['interface-name'] || null)
        ].filter(Boolean),
        sourceMethod: ['neighbor_discovery'],
        reachable: true,
        apiReachable: false,
        sshReachable: false,
        winboxReachable: false,
        rosVersion: record.version || null,
        macAddress: record['mac-address'] || record.macAddress || null,
        interfaceContext: record.interface || record['interface-name'] || null,
        viaRouter: { routerId: parentContext.routerId, routerName: parentContext.routerName },
        candidateSubnet: null,
        notes: explicitMikrotik ? 'Explicit MikroTik neighbor evidence.' : 'Neighbor data suggests router infrastructure.',
        adoptedRouterId: null,
        lastSeenAt: new Date()
    };
}

function normalizeCandidateSubnet(cidr, sourceMethod, priority, reason) {
    const parsed = parseCidr(cidr);
    if (!parsed) return null;
    return {
        cidr: parsed.cidr,
        prefix: parsed.prefix,
        sourceMethod,
        priority,
        reason
    };
}

function generateCandidateSubnets({ addressRecords = [], routeRecords = [], dhcpNetworks = [], options = {} }) {
    const warnings = [];
    const items = [];
    const seen = new Set();

    const pushSubnet = (cidr, sourceMethod, priority, reason) => {
        const normalized = normalizeCandidateSubnet(cidr, sourceMethod, priority, reason);
        if (!normalized) return;
        if (!isPrivateInfrastructureCidr(normalized.cidr)) return;
        if (options.allowedSubnetCidrs.length && !options.allowedSubnetCidrs.some((allowed) => cidrContains(allowed, stripCidr(normalized.cidr)))) {
            return;
        }
        if (options.excludeCidrs.some((excluded) => cidrContains(excluded, stripCidr(normalized.cidr)))) {
            warnings.push(`Skipped excluded subnet ${normalized.cidr}`);
            return;
        }
        if (normalized.prefix != null && normalized.prefix < 16) {
            warnings.push(`Skipped broad subnet ${normalized.cidr}`);
            return;
        }
        if (!seen.has(normalized.cidr)) {
            seen.add(normalized.cidr);
            items.push(normalized);
        }
    };

    addressRecords.forEach((record) => {
        if (record.network) {
            const cidr = `${stripCidr(record.network)}/${record['network-mask'] || record.prefix || '24'}`;
            pushSubnet(cidr, 'connected_subnet', 20, 'Connected subnet on parent router');
        } else if (record.address) {
            const parsed = parseCidr(record.address);
            if (parsed) {
                pushSubnet(parsed.cidr, 'connected_subnet', 20, 'Address assigned on parent router');
            }
        }
    });

    routeRecords.forEach((record) => {
        const dstAddress = record['dst-address'] || record.dstAddress;
        const active = String(record.active || record.dynamic || '').toLowerCase();
        if (!dstAddress || dstAddress === '0.0.0.0/0') return;
        if (active === 'false' || active === 'no') return;
        pushSubnet(dstAddress, 'route_table', 40, `Route via ${record.gateway || record['gateway-status'] || 'unknown'}`);
    });

    dhcpNetworks.forEach((record) => {
        const address = record.address || record.network;
        if (address) {
            pushSubnet(address, 'dhcp_network', 30, 'DHCP server network on parent router');
        }
    });

    items.sort((left, right) => left.priority - right.priority || left.cidr.localeCompare(right.cidr));
    return { subnets: items, warnings };
}

function buildLikelyIpsForSubnet(parsed) {
    if (parsed.prefix === 32) {
        return [intToIpv4(parsed.network)];
    }

    if (parsed.prefix === 31) {
        return [intToIpv4(parsed.network), intToIpv4(parsed.broadcast)];
    }

    const hostCount = Math.max(0, parsed.broadcast - parsed.network - 1);
    if (hostCount <= 0) return [];

    if (parsed.prefix >= 29) {
        const results = [];
        for (let current = parsed.network + 1; current < parsed.broadcast; current += 1) {
            results.push(intToIpv4(current));
        }
        return results;
    }

    const candidates = [
        parsed.network + 1,
        parsed.network + 2,
        parsed.network + 3,
        parsed.broadcast - 1,
        parsed.broadcast - 2
    ]
        .filter((value) => value > parsed.network && value < parsed.broadcast);

    return [...new Set(candidates)].map((value) => intToIpv4(value));
}

function getRouterHeuristicScore(ipAddress, candidateSubnet = null) {
    const normalizedIp = stripCidr(ipAddress);
    const ip = ipv4ToInt(normalizedIp);
    if (ip == null) return 0;

    const octets = normalizedIp.split('.').map((part) => Number(part));
    let score = 0;
    const lastOctet = octets[3];

    if ([1, 2, 254, 253].includes(lastOctet)) {
        score += 40;
    }
    if ([250, 251, 252].includes(lastOctet)) {
        score += 15;
    }

    const parsedSubnet = candidateSubnet ? parseCidr(candidateSubnet) : null;
    if (parsedSubnet) {
        if (ip === parsedSubnet.network + 1 || ip === parsedSubnet.broadcast - 1) {
            score += 35;
        }
        if (ip === parsedSubnet.network + 2 || ip === parsedSubnet.broadcast - 2) {
            score += 20;
        }
    }

    return score;
}

function generateProbeTargets({ candidateSubnets = [], routeRecords = [], arpRecords = [], neighborRecords = [], parentIps = [], options = {} }) {
    const warnings = [];
    const targets = [];
    const seen = new Set(parentIps.map((item) => stripCidr(item)).filter(Boolean));
    const candidateSubnetByIp = new Map();

    candidateSubnets.forEach((item) => {
        const parsed = parseCidr(item.cidr);
        if (!parsed) return;
        for (let current = parsed.network; current <= parsed.broadcast; current += 1) {
            candidateSubnetByIp.set(intToIpv4(current), item.cidr);
        }
    });

    const pushTarget = (ipAddress, sourceMethod, candidateSubnet, priority, evidence, optionsMeta = {}) => {
        const normalizedIp = stripCidr(ipAddress);
        if (!ipv4ToInt(normalizedIp) || seen.has(normalizedIp)) return;
        if (options.excludeCidrs.some((cidr) => cidrContains(cidr, normalizedIp))) return;
        if (options.allowedSubnetCidrs.length && !options.allowedSubnetCidrs.some((cidr) => cidrContains(cidr, normalizedIp))) return;
        seen.add(normalizedIp);
        const resolvedSubnet = candidateSubnet || candidateSubnetByIp.get(normalizedIp) || null;
        targets.push({
            ipAddress: normalizedIp,
            sourceMethod: [sourceMethod],
            candidateSubnet: resolvedSubnet,
            priority,
            evidence: evidence ? [evidence] : [],
            heuristicScore: Number(optionsMeta.heuristicScore || 0)
        });
    };

    neighborRecords.forEach((record) => {
        const ipAddress = record.address || record['address4'] || record['primary-address'];
        const neighborText = `${record.identity || ''} ${record.platform || ''} ${record.version || ''} ${record.board || ''}`.toLowerCase();
        const explicitMikrotik = /mikrotik|routeros/.test(neighborText);
        pushTarget(
            ipAddress,
            'neighbor_discovery',
            null,
            explicitMikrotik ? 1 : 4,
            explicitMikrotik ? 'Explicit MikroTik neighbor address' : 'Neighbor reported address',
            { heuristicScore: explicitMikrotik ? 100 : getRouterHeuristicScore(ipAddress, candidateSubnetByIp.get(stripCidr(ipAddress))) + 25 }
        );
    });

    routeRecords.forEach((record) => {
        const dstAddress = String(record['dst-address'] || record.dstAddress || '').trim();
        if (!dstAddress || dstAddress === '0.0.0.0/0') {
            return;
        }
        const gateway = stripCidr(record.gateway || record['gateway-status'] || '');
        if (ipv4ToInt(gateway)) {
            pushTarget(
                gateway,
                'route_next_hop',
                dstAddress,
                1,
                'Route next-hop',
                { heuristicScore: 120 }
            );
        }
    });

    const arpCandidatesBySubnet = new Map();
    arpRecords.forEach((record) => {
        const ipAddress = stripCidr(record.address);
        if (!ipv4ToInt(ipAddress) || seen.has(ipAddress)) return;
        if (options.excludeCidrs.some((cidr) => cidrContains(cidr, ipAddress))) return;
        if (options.allowedSubnetCidrs.length && !options.allowedSubnetCidrs.some((cidr) => cidrContains(cidr, ipAddress))) return;

        const candidateSubnet = candidateSubnetByIp.get(ipAddress) || 'unknown';
        const heuristicScore = getRouterHeuristicScore(ipAddress, candidateSubnetByIp.get(ipAddress));
        const entry = {
            ipAddress,
            candidateSubnet: candidateSubnet === 'unknown' ? null : candidateSubnet,
            heuristicScore
        };
        const bucket = arpCandidatesBySubnet.get(candidateSubnet) || [];
        bucket.push(entry);
        arpCandidatesBySubnet.set(candidateSubnet, bucket);
    });

    arpCandidatesBySubnet.forEach((entries) => {
        const sorted = entries.sort((left, right) =>
            right.heuristicScore - left.heuristicScore
            || left.ipAddress.localeCompare(right.ipAddress)
        );
        let strongCount = 0;
        let mediumCount = 0;
        let weakCount = 0;

        sorted.forEach((entry) => {
            const isStrong = entry.heuristicScore >= 40;
            const isMedium = entry.heuristicScore > 0 && entry.heuristicScore < 40;

            if (isStrong && strongCount >= 6) return;
            if (isMedium && mediumCount >= 4) return;
            if (!isStrong && !isMedium && weakCount >= 2) return;

            if (isStrong) strongCount += 1;
            else if (isMedium) mediumCount += 1;
            else weakCount += 1;

            pushTarget(
                entry.ipAddress,
                'arp_table',
                entry.candidateSubnet,
                isStrong ? 5 : (isMedium ? 14 : 35),
                'ARP table',
                { heuristicScore: entry.heuristicScore }
            );
        });
    });

    candidateSubnets.forEach((item) => {
        const parsed = parseCidr(item.cidr);
        if (!parsed) return;
        buildLikelyIpsForSubnet(parsed).forEach((ipAddress) => {
            pushTarget(
                ipAddress,
                'subnet_probe',
                item.cidr,
                item.priority + 20,
                item.reason,
                { heuristicScore: getRouterHeuristicScore(ipAddress, item.cidr) }
            );
        });
    });

    targets.sort((left, right) =>
        left.priority - right.priority
        || right.heuristicScore - left.heuristicScore
        || left.ipAddress.localeCompare(right.ipAddress)
    );
    if (targets.length > options.maxProbeTargets) {
        warnings.push(`Probe target list truncated from ${targets.length} to ${options.maxProbeTargets}`);
    }
    return {
        targets: targets.slice(0, options.maxProbeTargets).map((item) => ({
            ipAddress: item.ipAddress,
            sourceMethod: item.sourceMethod,
            candidateSubnet: item.candidateSubnet,
            priority: item.priority,
            evidence: item.evidence
        })),
        warnings
    };
}

function mergeDiscoveredRouters(items = []) {
    const merged = new Map();

    items.filter(Boolean).forEach((item) => {
        const key = stripCidr(item.ipAddress);
        const current = merged.get(key);
        if (!current) {
            merged.set(key, {
                ...item,
                evidence: [...new Set(item.evidence || [])],
                sourceMethod: [...new Set(item.sourceMethod || [])]
            });
            return;
        }

        const confidenceRank = { low: 1, medium: 2, high: 3 };
        merged.set(key, {
            ...current,
            identity: current.identity || item.identity || null,
            platform: current.platform || item.platform || null,
            vendor: current.vendor || item.vendor || null,
            confidence: (confidenceRank[item.confidence] || 0) > (confidenceRank[current.confidence] || 0) ? item.confidence : current.confidence,
            evidence: [...new Set([...(current.evidence || []), ...(item.evidence || [])])],
            sourceMethod: [...new Set([...(current.sourceMethod || []), ...(item.sourceMethod || [])])],
            reachable: current.reachable || item.reachable,
            apiReachable: current.apiReachable || item.apiReachable,
            sshReachable: current.sshReachable || item.sshReachable,
            winboxReachable: current.winboxReachable || item.winboxReachable,
            rosVersion: current.rosVersion || item.rosVersion || null,
            macAddress: current.macAddress || item.macAddress || null,
            interfaceContext: current.interfaceContext || item.interfaceContext || null,
            candidateSubnet: current.candidateSubnet || item.candidateSubnet || null,
            notes: current.notes || item.notes || null,
            lastSeenAt: current.lastSeenAt || item.lastSeenAt || new Date()
        });
    });

    return [...merged.values()];
}

function classifyCandidateFingerprint({ sshBanner, apiReachable, winboxReachable, neighborHint }) {
    if (neighborHint) {
        return {
            confidence: 'high',
            vendor: 'MikroTik',
            platform: 'RouterOS',
            evidence: ['Explicit MikroTik/RouterOS neighbor evidence']
        };
    }

    if (sshBanner && /routeros|mikrotik/i.test(sshBanner)) {
        return {
            confidence: 'high',
            vendor: 'MikroTik',
            platform: 'RouterOS',
            evidence: [`SSH banner matched RouterOS: ${sshBanner}`]
        };
    }

    if (winboxReachable && (apiReachable || sshBanner)) {
        return {
            confidence: 'medium',
            vendor: 'Likely MikroTik',
            platform: 'Possible RouterOS',
            evidence: ['Winbox reachable with additional management service evidence']
        };
    }

    if (winboxReachable) {
        return {
            confidence: 'low',
            vendor: 'Possible MikroTik',
            platform: null,
            evidence: ['Winbox management port reachable']
        };
    }

    return null;
}

function tcpProbe(ipAddress, port, timeoutMs, mode = 'connect') {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        let banner = '';

        const finalize = (payload) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(payload);
        };

        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => finalize({ reachable: false, banner: null }));
        socket.once('error', () => finalize({ reachable: false, banner: null }));

        socket.connect(port, ipAddress, () => {
            if (mode !== 'banner') {
                finalize({ reachable: true, banner: null });
                return;
            }
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => {
                banner += chunk;
                if (banner.length >= 128 || /\n/.test(banner)) {
                    finalize({ reachable: true, banner: banner.trim() || null });
                }
            });
            setTimeout(() => finalize({ reachable: true, banner: banner.trim() || null }), Math.min(timeoutMs, 1000));
        });
    });
}

async function pingTargetFromParent(routerId, ipAddress, timeoutMs, actorContext) {
    try {
        const result = await executeRouterOperation(routerId, 'ping', {
            command: '/ping',
            attributes: { address: ipAddress, count: '1' },
            timeout: timeoutMs,
            metadata: { targetIp: ipAddress }
        }, actorContext);
        const records = Array.isArray(result.records) ? result.records : [];
        return records.length > 0;
    } catch (error) {
        return false;
    }
}

async function adoptManagedRouterReference(candidate) {
    const managed = await MikrotikRouter.findOne({
        $or: [
            { 'discoveryInfo.localAddress': candidate.ipAddress },
            { vpnIp: `${candidate.ipAddress}/32` },
            { vpnIp: candidate.ipAddress }
        ]
    }).lean().catch(() => null);

    return managed ? String(managed._id) : null;
}

async function verifyProbeTarget(parentRouterId, target, parentContext, options, explicitNeighborMap, actorContext) {
    const reachable = await pingTargetFromParent(parentRouterId, target.ipAddress, options.timeoutMs, actorContext);
    if (!reachable) return null;

    const [sshProbe, apiProbe, winboxProbe] = await Promise.all([
        tcpProbe(target.ipAddress, options.portPreferences.ssh, options.timeoutMs, 'banner'),
        tcpProbe(target.ipAddress, options.portPreferences.api, options.timeoutMs),
        tcpProbe(target.ipAddress, options.portPreferences.winbox, options.timeoutMs)
    ]);

    const explicitNeighbor = explicitNeighborMap.get(target.ipAddress) || null;
    const fingerprint = classifyCandidateFingerprint({
        sshBanner: sshProbe.banner,
        apiReachable: apiProbe.reachable,
        winboxReachable: winboxProbe.reachable,
        neighborHint: Boolean(explicitNeighbor)
    });

    if (!fingerprint && !explicitNeighbor) {
        return null;
    }

    const discovered = {
        ipAddress: target.ipAddress,
        identity: explicitNeighbor?.identity || null,
        platform: explicitNeighbor?.platform || fingerprint?.platform || null,
        vendor: explicitNeighbor?.vendor || fingerprint?.vendor || null,
        confidence: explicitNeighbor?.confidence || fingerprint?.confidence || 'low',
        evidence: [
            ...(explicitNeighbor?.evidence || []),
            ...(fingerprint?.evidence || []),
            ...target.evidence
        ].filter(Boolean),
        sourceMethod: [...new Set([...(explicitNeighbor?.sourceMethod || []), ...(target.sourceMethod || [])])],
        reachable: true,
        apiReachable: Boolean(apiProbe.reachable),
        sshReachable: Boolean(sshProbe.reachable),
        winboxReachable: Boolean(winboxProbe.reachable),
        rosVersion: explicitNeighbor?.rosVersion || null,
        macAddress: explicitNeighbor?.macAddress || null,
        interfaceContext: explicitNeighbor?.interfaceContext || null,
        viaRouter: { routerId: parentContext.routerId, routerName: parentContext.routerName },
        candidateSubnet: target.candidateSubnet || null,
        notes: explicitNeighbor ? explicitNeighbor.notes : 'Route-informed targeted probe with MikroTik service evidence.',
        adoptedRouterId: null,
        lastSeenAt: new Date()
    };

    discovered.adoptedRouterId = await adoptManagedRouterReference(discovered);
    return discovered;
}

function serializeRun(run) {
    if (!run) return null;
    return {
        id: String(run._id),
        parentRouterId: String(run.parentRouterId),
        status: run.status,
        dryRun: Boolean(run.dryRun),
        timestamp: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt || null,
        sourceTunnelIp: run.sourceTunnelIp || null,
        sourceRouterIdentity: run.sourceRouterIdentity || null,
        sourceRouterVersion: run.sourceRouterVersion || null,
        discoveryMethodUsed: run.discoveryMethodUsed || [],
        candidateSubnets: run.candidateSubnets || [],
        previewTargets: (run.previewTargets || []).map((item) => ({
            ipAddress: item.ipAddress,
            sourceMethod: item.sourceMethod || [],
            candidateSubnet: item.candidateSubnet || null,
            priority: Number(item.priority || 0),
            evidence: item.evidence || []
        })),
        candidateSubnetCount: Number(run.candidateSubnetCount || 0),
        probedTargetCount: Number(run.probedTargetCount || 0),
        discoveredRouterCount: Array.isArray(run.discoveredRouters) ? run.discoveredRouters.length : 0,
        partialVisibility: Boolean(run.partialVisibility),
        warnings: run.warnings || [],
        errors: run.errors || [],
        discoveredRouters: (run.discoveredRouters || []).map((item) => ({
            ipAddress: item.ipAddress,
            identity: item.identity || null,
            platform: item.platform || null,
            vendor: item.vendor || null,
            confidence: item.confidence || 'low',
            evidence: item.evidence || [],
            sourceMethod: item.sourceMethod || [],
            reachable: Boolean(item.reachable),
            apiReachable: Boolean(item.apiReachable),
            sshReachable: Boolean(item.sshReachable),
            winboxReachable: Boolean(item.winboxReachable),
            rosVersion: item.rosVersion || null,
            macAddress: item.macAddress || null,
            interfaceContext: item.interfaceContext || null,
            viaRouter: item.viaRouter ? {
                routerId: item.viaRouter.routerId ? String(item.viaRouter.routerId) : null,
                routerName: item.viaRouter.routerName || null
            } : null,
            candidateSubnet: item.candidateSubnet || null,
            notes: item.notes || null,
            adoptedRouterId: item.adoptedRouterId ? String(item.adoptedRouterId) : null,
            lastSeenAt: item.lastSeenAt || null
        }))
    };
}

async function getLatestDownstreamDiscoveryRun(parentRouterId) {
    const run = await DownstreamRouterDiscoveryRun.findOne({ parentRouterId }).sort({ createdAt: -1 }).lean();
    return serializeRun(run);
}

async function discoverDownstreamMikrotiks(parentRouterId, rawOptions = {}, actorContext = {}) {
    const router = await MikrotikRouter.findById(parentRouterId).lean();
    if (!router) {
        throw new Error('Router not found');
    }

    const options = normalizeOptions(rawOptions);
    const actor = actorContext.actor || 'system';
    const actorType = actorContext.actorType || 'system';
    const warnings = [];
    const errors = [];

    const lease = await acquireDiscoveryLease(router._id, actor);
    if (!lease) {
        const error = new Error('A downstream discovery run is already active for this router');
        error.code = 'discovery_already_running';
        throw error;
    }

    const run = await DownstreamRouterDiscoveryRun.create({
        parentRouterId: router._id,
        actor,
        actorType,
        status: 'running',
        dryRun: Boolean(options.dryRun),
        options
    });

    log('info', 'downstream_mikrotik_discovery_started', {
        routerId: String(router._id),
        actor,
        dryRun: Boolean(options.dryRun),
        maxProbeTargets: options.maxProbeTargets
    });

    try {
        const actorMeta = {
            actor,
            actorType,
            requestId: actorContext.requestId || null
        };

        const [identityRecords, resourceRecords, addressRecords, routeRecords, arpRecords, neighborRecords, dhcpNetworks, wireguardPeers] = await Promise.all([
            safeExecute(router._id, '/system/identity/print', {}, warnings, actorMeta, { phase: 'identity', timeoutMs: options.timeoutMs }),
            safeExecute(router._id, '/system/resource/print', {}, warnings, actorMeta, { phase: 'resource', timeoutMs: options.timeoutMs }),
            safeExecute(router._id, '/ip/address/print', {}, warnings, actorMeta, { phase: 'addresses', timeoutMs: options.timeoutMs }),
            options.enableRouteInspection
                ? safeExecute(router._id, '/ip/route/print', {}, warnings, actorMeta, { phase: 'routes', timeoutMs: options.timeoutMs })
                : Promise.resolve([]),
            options.enableRouteInspection
                ? safeExecute(router._id, '/ip/arp/print', {}, warnings, actorMeta, { phase: 'arp', timeoutMs: options.timeoutMs })
                : Promise.resolve([]),
            options.enableNeighborDiscovery
                ? safeExecute(router._id, '/ip/neighbor/print', {}, warnings, actorMeta, { phase: 'neighbors', timeoutMs: options.timeoutMs })
                : Promise.resolve([]),
            options.enableRouteInspection
                ? safeExecute(router._id, '/ip/dhcp-server/network/print', {}, warnings, actorMeta, { phase: 'dhcp_networks', timeoutMs: options.timeoutMs })
                : Promise.resolve([]),
            safeExecute(router._id, '/interface/wireguard/peers/print', {}, warnings, actorMeta, { phase: 'wireguard_peers', timeoutMs: options.timeoutMs })
        ]);

        const parentContext = buildParentContext(router, identityRecords, resourceRecords);
        const parentIps = [
            parentContext.tunnelIp,
            stripCidr(router.discoveryInfo?.localAddress),
            ...addressRecords.map((record) => stripCidr(record.address))
        ].filter(Boolean);

        const neighborCandidates = neighborRecords
            .map((record) => normalizeNeighborCandidate(record, parentContext))
            .filter(Boolean)
            .filter((candidate) => !parentIps.includes(candidate.ipAddress));
        const explicitNeighborMap = new Map(neighborCandidates.map((candidate) => [candidate.ipAddress, candidate]));

        const subnetBundle = generateCandidateSubnets({
            addressRecords,
            routeRecords,
            dhcpNetworks,
            options
        });
        warnings.push(...subnetBundle.warnings);

        const probeBundle = generateProbeTargets({
            candidateSubnets: subnetBundle.subnets,
            routeRecords,
            arpRecords,
            neighborRecords,
            parentIps,
            options
        });
        warnings.push(...probeBundle.warnings);

        const discoveredByProbe = [];
        if (!options.dryRun && options.enableSubnetProbe) {
            for (const target of probeBundle.targets) {
                const verified = await verifyProbeTarget(router._id, target, parentContext, options, explicitNeighborMap, actorMeta);
                if (verified) {
                    discoveredByProbe.push(verified);
                }
            }
        }

        const discoveredRouters = mergeDiscoveredRouters([...neighborCandidates, ...discoveredByProbe]).map((candidate) => ({
            ...candidate,
            adoptedRouterId: candidate.adoptedRouterId || null
        }));

        const discoveryMethods = [
            neighborCandidates.length ? 'neighbor_discovery' : null,
            subnetBundle.subnets.length ? 'route_informed_subnets' : null,
            probeBundle.targets.length ? 'targeted_probe' : null,
            wireguardPeers.length ? 'wireguard_topology_context' : null
        ].filter(Boolean);

        const partialVisibility =
            discoveredRouters.length === 0 ||
            warnings.some((item) => /skipped broad subnet|truncated|failed/.test(item.toLowerCase()));

        run.status = 'completed';
        run.sourceTunnelIp = parentContext.tunnelIp;
        run.sourceRouterIdentity = parentContext.identity;
        run.sourceRouterVersion = parentContext.version;
        run.discoveryMethodUsed = discoveryMethods;
        run.candidateSubnets = subnetBundle.subnets.map((item) => item.cidr);
        run.previewTargets = probeBundle.targets;
        run.candidateSubnetCount = subnetBundle.subnets.length;
        run.probedTargetCount = probeBundle.targets.length;
        run.partialVisibility = partialVisibility;
        run.warnings = warnings;
        run.errors = errors;
        run.discoveredRouters = discoveredRouters;
        run.completedAt = new Date();
        await run.save();

        log('info', 'downstream_mikrotik_discovery_completed', {
            routerId: String(router._id),
            runId: String(run._id),
            discoveredRouterCount: discoveredRouters.length,
            candidateSubnetCount: subnetBundle.subnets.length,
            probedTargetCount: probeBundle.targets.length,
            partialVisibility
        });

        return serializeRun(run.toObject ? run.toObject() : run);
    } catch (error) {
        errors.push(error.message || 'Downstream discovery failed');
        run.status = 'failed';
        run.errors = errors;
        run.warnings = warnings;
        run.completedAt = new Date();
        await run.save().catch(() => undefined);

        log('error', 'downstream_mikrotik_discovery_failed', {
            routerId: String(router._id),
            runId: String(run._id),
            error: error.message || String(error)
        });
        throw error;
    } finally {
        await releaseDiscoveryLease(router._id);
    }
}

async function discoverDownstreamMikrotiksForEligibleRouters(rawOptions = {}, actorContext = {}) {
    const routers = await MikrotikRouter.find({ status: 'active' }).select('_id').lean();
    const results = [];

    for (const router of routers) {
        try {
            const result = await discoverDownstreamMikrotiks(router._id, rawOptions, actorContext);
            results.push({ routerId: String(router._id), success: true, result });
        } catch (error) {
            results.push({ routerId: String(router._id), success: false, error: error.message || String(error) });
        }
    }

    return results;
}

module.exports = {
    DEFAULT_OPTIONS,
    DISCOVERY_JOB_TYPE,
    normalizeOptions,
    parseCidr,
    cidrContains,
    generateCandidateSubnets,
    generateProbeTargets,
    mergeDiscoveredRouters,
    classifyCandidateFingerprint,
    getLatestDownstreamDiscoveryRun,
    discoverDownstreamMikrotiks,
    discoverDownstreamMikrotiksForEligibleRouters,
    serializeRun
};
