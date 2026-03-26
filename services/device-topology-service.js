const mongoose = require('mongoose');
const ConnectedDevice = require('../models/ConnectedDevice');
const RouterLocation = require('../models/RouterLocation');
const MikrotikRouter = require('../models/MikrotikRouter');

function toObjectId(id) {
    return new mongoose.Types.ObjectId(id);
}

function normalizeString(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function normalizeMacAddress(value) {
    const normalized = normalizeString(value);
    if (!normalized) return null;
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function inferDeviceType(deviceData = {}) {
    const explicitType = normalizeString(deviceData.deviceType);
    if (explicitType && explicitType !== 'unknown') {
        return explicitType;
    }

    const source = normalizeString(deviceData.discoverySource) || 'unknown';
    const descriptor = [
        deviceData.deviceName,
        deviceData.manufacturer,
        deviceData.model,
        deviceData.interfaceName,
        deviceData.notes
    ]
        .map((value) => normalizeString(value))
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const phoneLike = /(iphone|android|samsung|pixel|redmi|tecno|infinix|huawei|oppo|vivo|phone|tablet|ipad|macbook|laptop|desktop|workstation|windows|client)/;
    const routerLike = /(routeros|mikrotik|\brouter\b|\bgateway\b|\bcore\b|\bedge\b|\brtr\b|rb\d|hap|hex|ccr|gateway)/;
    const accessPointLike = /(access point|access-point|\bap\b|\bcap\b|\bcpe\b|\bwap\b|\beap\b|\bssid\b|\bwifi\b)/;
    const switchLike = /(switch|crs|css|ethernet switch|gs108|sg\d+)/;

    if (phoneLike.test(descriptor)) return 'client';
    if (source === 'bgp') return 'router';
    if (routerLike.test(descriptor)) return 'router';
    if (switchLike.test(descriptor)) return 'switch';
    if (accessPointLike.test(descriptor)) return 'access_point';
    if (source === 'neighbor') return 'router';
    if (['wireless', 'wireguard', 'pppoe', 'hotspot', 'arp'].includes(source)) return 'client';

    return 'unknown';
}

function getDeviceTypePriority(deviceType) {
    switch (deviceType) {
        case 'router':
            return 5;
        case 'access_point':
            return 4;
        case 'switch':
            return 3;
        case 'client':
            return 2;
        default:
            return 1;
    }
}

function getDiscoverySourcePriority(source) {
    switch (source) {
        case 'neighbor':
        case 'bgp':
            return 5;
        case 'wireguard':
            return 4;
        case 'wireless':
        case 'pppoe':
        case 'hotspot':
            return 3;
        case 'arp':
            return 2;
        case 'manual':
            return 1;
        default:
            return 0;
    }
}

function mergeDeviceRecord(existing = {}, incoming = {}) {
    const existingType = normalizeString(existing.deviceType) || 'unknown';
    const incomingType = normalizeString(incoming.deviceType) || 'unknown';
    const existingSource = normalizeString(existing.discoverySource) || 'unknown';
    const incomingSource = normalizeString(incoming.discoverySource) || 'unknown';

    return {
        ...existing,
        ...incoming,
        deviceType: getDeviceTypePriority(existingType) >= getDeviceTypePriority(incomingType)
            ? existingType
            : incomingType,
        discoverySource: getDiscoverySourcePriority(existingSource) >= getDiscoverySourcePriority(incomingSource)
            ? existingSource
            : incomingSource,
        manufacturer: normalizeString(existing.manufacturer) || normalizeString(incoming.manufacturer),
        model: normalizeString(existing.model) || normalizeString(incoming.model),
        interfaceName: normalizeString(existing.interfaceName) || normalizeString(incoming.interfaceName),
        latitude: existing.latitude ?? incoming.latitude ?? null,
        longitude: existing.longitude ?? incoming.longitude ?? null,
        location: normalizeString(existing.location) || normalizeString(incoming.location),
        publicKey: normalizeString(existing.publicKey) || normalizeString(incoming.publicKey),
        macAddress: normalizeMacAddress(existing.macAddress) || normalizeMacAddress(incoming.macAddress)
    };
}

function buildIdentityParts(deviceData = {}) {
    const publicKey = normalizeString(deviceData.publicKey);
    const macAddress = normalizeMacAddress(deviceData.macAddress || deviceData.deviceId);
    const deviceId = normalizeString(deviceData.deviceId);
    const ipAddress = normalizeString(deviceData.ipAddress);

    if (publicKey) {
        return {
            identityKey: `publicKey:${publicKey}`,
            aliases: [{ publicKey }]
        };
    }

    if (macAddress) {
        return {
            identityKey: `mac:${macAddress}`,
            aliases: [{ macAddress }, { deviceId: macAddress }]
        };
    }

    if (deviceId) {
        return {
            identityKey: `device:${deviceId}`,
            aliases: [{ deviceId }]
        };
    }

    if (ipAddress) {
        return {
            identityKey: `ip:${ipAddress}`,
            aliases: [{ ipAddress }]
        };
    }

    return {
        identityKey: null,
        aliases: []
    };
}

function buildDeviceSelector(parentRouterId, identityParts) {
    const selector = { parentRouterId };
    const aliases = Array.isArray(identityParts.aliases) ? [...identityParts.aliases] : [];

    if (identityParts.identityKey) {
        aliases.unshift({ identityKey: identityParts.identityKey });
    }

    if (aliases.length === 1) {
        return { ...selector, ...aliases[0] };
    }

    if (aliases.length > 1) {
        return { ...selector, $or: aliases };
    }

    return selector;
}

function sanitizeDeviceData(deviceData = {}) {
    const sanitized = {
        ...deviceData,
        deviceId: normalizeString(deviceData.deviceId),
        deviceName: normalizeString(deviceData.deviceName),
        deviceType: inferDeviceType(deviceData),
        ipAddress: normalizeString(deviceData.ipAddress),
        macAddress: normalizeMacAddress(deviceData.macAddress),
        publicKey: normalizeString(deviceData.publicKey),
        interfaceName: normalizeString(deviceData.interfaceName),
        manufacturer: normalizeString(deviceData.manufacturer),
        model: normalizeString(deviceData.model),
        firmware: normalizeString(deviceData.firmware),
        location: normalizeString(deviceData.location),
        notes: normalizeString(deviceData.notes),
        customLabel: normalizeString(deviceData.customLabel),
        discoverySource: normalizeString(deviceData.discoverySource) || 'manual'
    };

    const identityParts = buildIdentityParts(sanitized);
    if (!sanitized.deviceId && identityParts.identityKey) {
        sanitized.deviceId = identityParts.identityKey;
    }

    sanitized.identityKey = identityParts.identityKey;

    return { sanitized, identityParts };
}

function buildLiveTopologyFilter(parentRouterId) {
    return {
        parentRouterId,
        isOnline: true,
        discoverySource: {
            $in: ['neighbor', 'bgp', 'wireless', 'wireguard', 'pppoe', 'hotspot', 'manual']
        }
    };
}

/**
 * Get all connected devices for a router with location data
 */
async function getConnectedDevicesWithLocations(parentRouterId) {
    const routerObjectId = toObjectId(parentRouterId);
    await reclassifyUnknownDevices(parentRouterId);

    const devices = await ConnectedDevice.find(buildLiveTopologyFilter(routerObjectId))
        .populate('trackedRouterId', 'name status')
        .sort({ lastSeen: -1 });

    // Enrich with parent router location
    const parentLocation = await RouterLocation.findOne({ routerId: routerObjectId });

    return {
        parentLocation,
        devices
    };
}

/**
 * Get network topology - all connected routers and their hierarchy
 */
async function getNetworkTopology(parentRouterId) {
    const parent = await MikrotikRouter.findById(parentRouterId);
    if (!parent) throw new Error('Router not found');

    // Get direct connections
    const directConnections = await ConnectedDevice.find({
        ...buildLiveTopologyFilter(parentRouterId),
        isManagedByUser: true
    }).populate('trackedRouterId');

    // Get location for parent
    const parentLocation = await RouterLocation.findOne({ routerId: toObjectId(parentRouterId) });

    // Map out the hierarchy
    const topology = {
        router: {
            id: parent._id.toString(),
            name: parent.name,
            status: parent.status,
            location: parentLocation
        },
        connections: []
    };

    // For each managed device that's a router, get its connections too
    for (const device of directConnections) {
        if (device.trackedRouterId) {
            const childDeviceLocation = await RouterLocation.findOne({
                routerId: device.trackedRouterId._id
            });

            const childConnections = await ConnectedDevice.find({
                ...buildLiveTopologyFilter(device.trackedRouterId._id)
            }).limit(10); // Limit to 10 per tier to avoid too much data

            topology.connections.push({
                device,
                childRouter: {
                    id: device.trackedRouterId._id.toString(),
                    name: device.trackedRouterId.name,
                    status: device.trackedRouterId.status,
                    location: childDeviceLocation
                },
                childConnections: childConnections.length,
                childDevices: childConnections.slice(0, 5)
            });
        } else {
            topology.connections.push({
                device,
                childRouter: null,
                childConnections: 0,
                childDevices: []
            });
        }
    }

    return topology;
}

/**
 * Add or update a connected device
 */
async function upsertConnectedDevice(parentRouterId, deviceData) {
    const { sanitized, identityParts } = sanitizeDeviceData(deviceData);
    const {
        deviceId,
        deviceName,
        deviceType,
        ipAddress,
        macAddress,
        publicKey,
        identityKey,
        discoverySource,
        ...otherData
    } = sanitized;

    if (!parentRouterId || !deviceId || !ipAddress) {
        throw new Error('parentRouterId, deviceId, and ipAddress are required');
    }

    const selector = buildDeviceSelector(parentRouterId, identityParts);
    const existingDevice = await ConnectedDevice.findOne(selector).lean();
    const mergedDevice = mergeDeviceRecord(existingDevice || {}, {
        deviceId,
        identityKey,
        deviceName,
        deviceType,
        ipAddress,
        macAddress,
        publicKey,
        discoverySource,
        ...otherData,
        lastSeen: new Date()
    });

    const device = await ConnectedDevice.findOneAndUpdate(
        existingDevice ? { _id: existingDevice._id } : selector,
        mergedDevice,
        { upsert: true, new: true }
    );

    return device;
}

/**
 * Update connected device location
 */
async function updateConnectedDeviceLocation(deviceId, parentRouterId, location) {
    const { latitude, longitude, address, city, region, country } = location;

    if (!latitude || !longitude) {
        throw new Error('latitude and longitude are required');
    }

    const device = await ConnectedDevice.findOneAndUpdate(
        { deviceId, parentRouterId },
        {
            latitude,
            longitude,
            location: address,
            city,
            region,
            country,
            $set: { lastUpdated: new Date() }
        },
        { new: true }
    );

    return device;
}

/**
 * Mark device as offline if not seen recently
 */
async function updateDeviceStatus(parentRouterId, deviceId, isOnline = false) {
    const device = await ConnectedDevice.findOneAndUpdate(
        { parentRouterId, deviceId },
        {
            isOnline,
            lastSeen: new Date()
        },
        { new: true }
    );

    return device;
}

async function markMissingDevicesOffline(parentRouterId, discoverySource, activeIdentityKeys = [], observedAt = new Date()) {
    if (!parentRouterId || !discoverySource) {
        throw new Error('parentRouterId and discoverySource are required');
    }

    const filter = {
        parentRouterId,
        discoverySource
    };

    if (Array.isArray(activeIdentityKeys) && activeIdentityKeys.length > 0) {
        filter.identityKey = { $nin: activeIdentityKeys };
    }

    const result = await ConnectedDevice.updateMany(
        filter,
        {
            $set: {
                isOnline: false,
                lastSeen: observedAt
            }
        }
    );

    return result;
}

async function reclassifyUnknownDevices(parentRouterId) {
    const unknownDevices = await ConnectedDevice.find({
        parentRouterId: toObjectId(parentRouterId),
        $or: [
            { deviceType: { $exists: false } },
            { deviceType: null },
            { deviceType: 'unknown' }
        ]
    }).select('_id deviceName deviceType discoverySource ipAddress macAddress manufacturer model interfaceName notes');

    if (!unknownDevices.length) {
        return { matched: 0, updated: 0 };
    }

    const operations = unknownDevices
        .map((device) => {
            const inferredType = inferDeviceType(device.toObject ? device.toObject() : device);
            if (!inferredType || inferredType === 'unknown') {
                return null;
            }

            return {
                updateOne: {
                    filter: { _id: device._id },
                    update: { $set: { deviceType: inferredType } }
                }
            };
        })
        .filter(Boolean);

    if (!operations.length) {
        return { matched: unknownDevices.length, updated: 0 };
    }

    const result = await ConnectedDevice.bulkWrite(operations);
    return {
        matched: unknownDevices.length,
        updated: result.modifiedCount || 0
    };
}

/**
 * Get connection statistics
 */
async function getConnectionStats(parentRouterId) {
    await reclassifyUnknownDevices(parentRouterId);
    const stats = await ConnectedDevice.aggregate([
        { $match: buildLiveTopologyFilter(toObjectId(parentRouterId)) },
        {
            $group: {
                _id: null,
                totalDevices: { $sum: 1 },
                onlineDevices: {
                    $sum: { $cond: ['$isOnline', 1, 0] }
                },
                offlineDevices: {
                    $sum: { $cond: ['$isOnline', 0, 1] }
                },
                avgLatency: { $avg: '$latency' },
                avgPacketLoss: { $avg: '$packetLoss' },
                avgBandwidth: { $avg: '$bandwidth' },
                accessPoints: {
                    $sum: { $cond: [{ $eq: ['$deviceType', 'access_point'] }, 1, 0] }
                },
                routers: {
                    $sum: { $cond: [{ $eq: ['$deviceType', 'router'] }, 1, 0] }
                },
                clients: {
                    $sum: { $cond: [{ $eq: ['$deviceType', 'client'] }, 1, 0] }
                }
            }
        }
    ]);

    return stats[0] || {
        totalDevices: 0,
        onlineDevices: 0,
        offlineDevices: 0,
        avgLatency: 0,
        avgPacketLoss: 0,
        avgBandwidth: 0,
        accessPoints: 0,
        routers: 0,
        clients: 0
    };
}

/**
 * Get geohash-based device clustering (for map optimization)
 */
async function getDevicesClustered(parentRouterId, zoom = 4) {
    // Simple clustering by region
    const devices = await ConnectedDevice.find({
        ...buildLiveTopologyFilter(parentRouterId),
        latitude: { $exists: true, $ne: null },
        longitude: { $exists: true, $ne: null }
    }).select('deviceName latitude longitude location isOnline deviceType');

    // Group by region or use geohashing
    const clustered = devices.reduce((acc, device) => {
        const key = device.location || `${Math.floor(device.latitude)},${Math.floor(device.longitude)}`;
        if (!acc[key]) {
            acc[key] = {
                cluster: key,
                count: 0,
                devices: [],
                bounds: {
                    north: device.latitude,
                    south: device.latitude,
                    east: device.longitude,
                    west: device.longitude
                }
            };
        }

        acc[key].count++;
        acc[key].devices.push({
            id: device._id,
            name: device.deviceName,
            lat: device.latitude,
            lng: device.longitude,
            online: device.isOnline,
            type: device.deviceType
        });

        acc[key].bounds.north = Math.max(acc[key].bounds.north, device.latitude);
        acc[key].bounds.south = Math.min(acc[key].bounds.south, device.latitude);
        acc[key].bounds.east = Math.max(acc[key].bounds.east, device.longitude);
        acc[key].bounds.west = Math.min(acc[key].bounds.west, device.longitude);

        return acc;
    }, {});

    return Object.values(clustered);
}

module.exports = {
    getConnectedDevicesWithLocations,
    getNetworkTopology,
    upsertConnectedDevice,
    updateConnectedDeviceLocation,
    updateDeviceStatus,
    markMissingDevicesOffline,
    reclassifyUnknownDevices,
    getConnectionStats,
    getDevicesClustered
};
