const express = require('express');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { ADMIN_ROUTER_PERMISSIONS } = require('../services/admin-router-service');
const {
    getConnectedDevicesWithLocations,
    getNetworkTopology,
    upsertConnectedDevice,
    updateConnectedDeviceLocation,
    updateDeviceStatus,
    getConnectionStats,
    getDevicesClustered
} = require('../services/device-topology-service');
const {
    runFullDeviceDiscovery,
    discoverWirelessDevices,
    discoverArpDevices,
    discoverWireGuardPeers
} = require('../services/mikrotik-device-discovery');

function registerTopologyRoutes(app) {
    function normalizeTimeoutMs(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return undefined;
        return Math.max(1000, Math.min(7000, parsed));
    }

    function normalizeSources(value) {
        if (!Array.isArray(value)) return undefined;
        const allowed = ['wireless', 'arp', 'bgp', 'neighbor', 'wireguard', 'pppoe', 'hotspot'];
        const sources = value.map((item) => String(item || '').trim().toLowerCase()).filter((item) => allowed.includes(item));
        return sources.length ? sources : undefined;
    }

    /**
     * GET /api/admin/routers/:id/topology/devices
     * Get all connected devices for a router
     */
    app.get(
        '/api/admin/routers/:id/topology/devices',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const data = await getConnectedDevicesWithLocations(req.params.id);
                res.json({ success: true, data });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to load connected devices'
                });
            }
        }
    );

    /**
     * GET /api/admin/routers/:id/topology/network
     * Get full network topology (multi-level hierarchy)
     */
    app.get(
        '/api/admin/routers/:id/topology/network',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const topology = await getNetworkTopology(req.params.id);
                res.json({ success: true, data: topology });
            } catch (error) {
                res.status(error.message === 'Router not found' ? 404 : 500).json({
                    success: false,
                    error: error.message || 'Failed to load network topology'
                });
            }
        }
    );

    /**
     * GET /api/admin/routers/:id/topology/stats
     * Get connection statistics and metrics
     */
    app.get(
        '/api/admin/routers/:id/topology/stats',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const stats = await getConnectionStats(req.params.id);
                res.json({ success: true, data: stats });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to load connection statistics'
                });
            }
        }
    );

    /**
     * GET /api/admin/routers/:id/topology/clusters
     * Get clustered devices for map visualization (optimized for mapping)
     */
    app.get(
        '/api/admin/routers/:id/topology/clusters',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const zoom = Math.max(1, Math.min(20, Number(req.query.zoom || 4)));
                const clusters = await getDevicesClustered(req.params.id, zoom);
                res.json({ success: true, data: clusters });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to load device clusters'
                });
            }
        }
    );

    /**
     * POST /api/admin/routers/:id/topology/devices/:deviceId/location
     * Update location of a connected device
     */
    app.post(
        '/api/admin/routers/:id/topology/devices/:deviceId/location',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const { latitude, longitude, address, city, region, country } = req.body;

                if (typeof latitude !== 'number' || typeof longitude !== 'number') {
                    return res.status(400).json({
                        success: false,
                        error: 'latitude and longitude must be numbers'
                    });
                }

                const device = await updateConnectedDeviceLocation(
                    req.params.deviceId,
                    req.params.id,
                    { latitude, longitude, address, city, region, country }
                );

                res.json({
                    success: true,
                    message: 'Device location updated',
                    data: device
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to update device location'
                });
            }
        }
    );

    /**
     * POST /api/admin/routers/:id/topology/devices
     * Add or update a connected device
     */
    app.post(
        '/api/admin/routers/:id/topology/devices',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const {
                    deviceId,
                    deviceName,
                    deviceType,
                    ipAddress,
                    macAddress,
                    publicKey,
                    latitude,
                    longitude,
                    location,
                    ...otherData
                } = req.body;

                if (!deviceId || !ipAddress) {
                    return res.status(400).json({
                        success: false,
                        error: 'deviceId and ipAddress are required'
                    });
                }

                const device = await upsertConnectedDevice(req.params.id, {
                    deviceId,
                    deviceName,
                    deviceType,
                    ipAddress,
                    macAddress,
                    publicKey,
                    latitude,
                    longitude,
                    location,
                    ...otherData
                });

                res.json({
                    success: true,
                    message: 'Device added/updated',
                    data: device
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to add/update device'
                });
            }
        }
    );

    /**
     * PATCH /api/admin/routers/:id/topology/devices/:deviceId/status
     * Update device online/offline status
     */
    app.patch(
        '/api/admin/routers/:id/topology/devices/:deviceId/status',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const { isOnline } = req.body;

                if (typeof isOnline !== 'boolean') {
                    return res.status(400).json({
                        success: false,
                        error: 'isOnline must be a boolean'
                    });
                }

                const device = await updateDeviceStatus(
                    req.params.id,
                    req.params.deviceId,
                    isOnline
                );

                res.json({
                    success: true,
                    message: 'Device status updated',
                    data: device
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to update device status'
                });
            }
        }
    );

    /**
     * POST /api/admin/routers/:id/topology/discover
     * Trigger device discovery on the router
     */
    app.post(
        '/api/admin/routers/:id/topology/discover',
        requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS),
        async (req, res) => {
            try {
                const actorContext = {
                    actor: req.adminUser?.email || 'admin',
                    reason: 'Manual device discovery trigger'
                };

                const result = await runFullDeviceDiscovery(req.params.id, actorContext, {
                    timeoutMs: normalizeTimeoutMs(req.body?.timeoutMs),
                    sources: normalizeSources(req.body?.sources)
                });

                if (result.status === 'failed') {
                    return res.status(502).json({
                        success: false,
                        error: 'Device discovery failed for all probes',
                        data: result
                    });
                }

                res.json({
                    success: true,
                    message: result.status === 'partial'
                        ? 'Device discovery completed with warnings'
                        : 'Device discovery completed',
                    data: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message || 'Failed to run device discovery'
                });
            }
        }
    );
}

module.exports = { registerTopologyRoutes };
