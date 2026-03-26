# Network Topology & Device Mapping Implementation Guide

This guide explains how to implement and use the network topology and device mapping features in your MikroTik admin application.

## Overview

The implementation allows you to:
- Track connected routers, APs, and clients from your main MikroTik router
- Display them on an interactive geographic map
- Show virtual connections between devices
- View connection metrics and statistics
- Support multi-level hierarchy (router → device → sub-routers)

## Architecture

### Backend Components

1. **Models**
   - `RouterLocation.js` - Geographic location data for routers
   - `ConnectedDevice.js` - Connected devices/APs with location and metrics

2. **Services**
   - `device-topology-service.js` - Business logic for topology management

3. **Routes**
   - `routes/topology.js` - REST API endpoints for topology data

### Frontend Components

1. **Hooks**
   - `useTopology.ts` - React Query hooks for fetching topology data

2. **Components**
   - `NetworkTopoMap.tsx` - Interactive map visualization with Leaflet
   - `NetworkTopologyViewer.tsx` - Full-featured topology view with stats

## Installation

### 1. Install Backend Dependencies

```bash
# In wireguard-server-main directory
npm install leaflet leaflet-draw
```

### 2. Install Frontend Dependencies

```bash
cd frontend
npm install leaflet leaflet-draw
npm install --save-dev @types/leaflet
```

### 3. Register Routes

In your main Express app (`wireguard-server-main/db.js` or main app file), add:

```javascript
const { registerTopologyRoutes } = require('./routes/topology');

// Add after your other route registrations:
registerTopologyRoutes(app);
```

### 4. Create Database Collections

The models will automatically create collections when first accessed. No migration needed.

## Usage

### Backend - Adding Connected Devices

You can populate device data from your MikroTik router's interface list:

```javascript
const deviceTopologyService = require('./services/device-topology-service');

// Example: Adding detected APs/clients
await deviceTopologyService.upsertConnectedDevice(routerId, {
  deviceId: 'unique-device-id',
  deviceName: 'AP-Office',
  deviceType: 'access_point',
  ipAddress: '192.168.1.100',
  macAddress: '00:11:22:33:44:55',
  manufacturer: 'MikroTik',
  model: 'hAP ac3',
  isOnline: true,
  latitude: 37.7749,    // Optional - manual or auto-populated
  longitude: -122.4194,
  location: 'Office Building A'
});
```

### Backend - Updating Device Location

```javascript
await deviceTopologyService.updateConnectedDeviceLocation(
  'device-id',
  routerId,
  {
    latitude: 37.7749,
    longitude: -122.4194,
    address: '123 Main St, San Francisco, CA',
    city: 'San Francisco',
    region: 'California',
    country: 'USA'
  }
);
```

### Frontend - Using the Network Map

#### In a React Page

```typescript
import { NetworkTopologyViewer } from '@/features/routers/components/NetworkTopologyViewer';

export function RouterDetailsPage({ routerId }: { routerId: string }) {
  return (
    <div>
      <h1>Network Topology</h1>
      <NetworkTopologyViewer routerId={routerId} />
    </div>
  );
}
```

#### Custom Map Integration

```typescript
import { useConnectedDevices, transformDevicesToMarkers } from '@/features/routers/hooks/useTopology';
import { NetworkTopoMap } from '@/features/routers/components/NetworkTopoMap';

export function CustomMapView({ routerId }: { routerId: string }) {
  const { data } = useConnectedDevices(routerId);
  
  if (!data) return <div>Loading...</div>;

  const markers = transformDevicesToMarkers(data.devices);

  return (
    <NetworkTopoMap
      routerId={routerId}
      parentLocation={data.parentLocation}
      devices={markers}
      height="600px"
      onDeviceClick={(device) => console.log('Selected:', device)}
    />
  );
}
```

## API Endpoints

### GET `/api/admin/routers/:id/topology/devices`
Get all connected devices with locations.

**Response:**
```json
{
  "success": true,
  "data": {
    "parentLocation": {
      "latitude": 37.7749,
      "longitude": -122.4194,
      "address": "San Francisco, CA"
    },
    "devices": [
      {
        "_id": "...",
        "deviceName": "AP-Office",
        "deviceType": "access_point",
        "ipAddress": "192.168.1.100",
        "latitude": 37.7750,
        "longitude": -122.4193,
        "isOnline": true,
        "lastSeen": "2024-03-24T10:30:00Z"
      }
    ]
  }
}
```

### GET `/api/admin/routers/:id/topology/network`
Get full network topology (multi-level hierarchy).

### GET `/api/admin/routers/:id/topology/stats`
Get connection statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalDevices": 12,
    "onlineDevices": 10,
    "offlineDevices": 2,
    "avgLatency": 45.2,
    "avgPacketLoss": 1.5,
    "avgBandwidth": 85.3,
    "accessPoints": 3,
    "routers": 2,
    "clients": 7
  }
}
```

### GET `/api/admin/routers/:id/topology/clusters`
Get clustered devices for map optimization (zoom parameter supported).

### POST `/api/admin/routers/:id/topology/devices/:deviceId/location`
Update device location.

**Request:**
```json
{
  "latitude": 37.7750,
  "longitude": -122.4193,
  "address": "Corner of Main and 5th",
  "city": "San Francisco",
  "region": "California",
  "country": "USA"
}
```

### POST `/api/admin/routers/:id/topology/devices`
Add or update a connected device.

### PATCH `/api/admin/routers/:id/topology/devices/:deviceId/status`
Update device online/offline status.

## Integration with MikroTik API

To automatically populate device data from your MikroTik routers, create a background job:

```javascript
// services/mikrotik-device-discovery.js
const deviceTopologyService = require('./device-topology-service');

async function scanRouterForConnectedDevices(routerId) {
  const router = await MikrotikRouter.findById(routerId);
  
  try {
    // Get connected devices from MikroTik API
    const devices = await executeRouterOperation(routerId, 'get_interfaces', {});
    
    // Get ARP table to find connected clients
    const arpTable = await executeRouterOperation(routerId, 'ip/arp/getall', {});
    
    for (const entry of arpTable) {
      await deviceTopologyService.upsertConnectedDevice(routerId, {
        deviceId: entry.macAddress,
        deviceName: entry.comment || `Device ${entry.address}`,
        deviceType: 'client',
        ipAddress: entry.address,
        macAddress: entry.macAddress,
        isOnline: !entry.disabled,
        // Location would need to be populated from other sources
        // or manually set
      });
    }
  } catch (error) {
    console.error('Failed to scan router for devices:', error);
  }
}
```

## Geolocation Integration Options

### Option 1: IP Geolocation API (Recommended for Quick Setup)

```javascript
const axios = require('axios');

async function getLocationFromIP(ipAddress) {
  try {
    const response = await axios.get(
      `https://ipapi.co/${ipAddress}/json/`
    );
    return {
      latitude: response.data.latitude,
      longitude: response.data.longitude,
      city: response.data.city,
      region: response.data.region,
      country: response.data.country_name,
      isp: response.data.org
    };
  } catch (error) {
    console.error('Geolocation lookup failed:', error);
    return null;
  }
}

// Usage:
const location = await getLocationFromIP(device.ipAddress);
if (location) {
  await deviceTopologyService.updateConnectedDeviceLocation(
    device.deviceId,
    routerId,
    location
  );
}
```

### Option 2: Google Maps Geocoding

```javascript
const { Client } = require('@googlemaps/js-api-loader');

const client = new Client({
  apiKey: process.env.GOOGLE_MAPS_API_KEY
});

async function geocodeAddress(address) {
  const response = await client.geocode({
    address
  });
  
  if (response.results[0]) {
    const location = response.results[0].geometry.location;
    return {
      latitude: location.lat(),
      longitude: location.lng()
    };
  }
}
```

### Option 3: Manual Location Assignment

Users can manually set device locations through the API or UI:
```javascript
// POST /api/admin/routers/:id/topology/devices/:deviceId/location
{
  "latitude": 37.7749,
  "longitude": -122.4194,
  "address": "123 Main Street"
}
```

## Customization

### Styling the Map

Edit `NetworkTopoMap.tsx` to customize:
- Colors and icons for different device types
- Line styles for connections
- Marker sizes and popups

### Adding More Metrics

In `ConnectedDevice.js` model, add more fields:
```javascript
rssi: Number,           // Signal strength
uptime: String,         // Device uptime
cpu: Number,           // CPU usage percentage
memory: Number,        // Memory usage
temperature: Number    // Temperature
```

### Custom Connection Types

Extend device types in the model:
```javascript
deviceType: {
  enum: ['access_point', 'router', 'client', 'switch', 'repeater', 'bridge', 'unknown'],
  default: 'unknown'
}
```

## Performance Considerations

1. **Large Device Lists**: Use clustering at zoom level 3-4
2. **Real-time Updates**: Implement WebSocket updates instead of polling
3. **Caching**: The API responses are cached for 30 seconds
4. **Database Indexes**: Ensure indexes on `parentRouterId`, `isOnline`, and coordinates

```javascript
// Good query performance
db.connected_devices
  .find({ parentRouterId: ObjectId, isOnline: true })
  .hint({ parentRouterId: 1, isOnline: 1 })
```

## Security

- Ensure topology data is only accessible to authorized admins
- The endpoints use `requireAdminPermission(ADMIN_ROUTER_PERMISSIONS.VIEW_DETAILS)`
- Location data could reveal sensitive infrastructure information - consider access controls
- IP geolocation lookups should be rate-limited

## Troubleshooting

### Map Not Loading

1. Check Leaflet CDN/module import
2. Verify div container has height specified
3. Check browser console for errors

### No Devices Appearing

1. Verify devices are being inserted into the database
2. Check coordinates are not null/undefined
3. Ensure `isOnline` status is correctly set

### Performance Issues

1. Reduce number of devices shown at once using clustering
2. Implement pagination for device lists
3. Use debouncing for search/filter operations

## Next Steps

1. Integrate with your MikroTik API to auto-populate devices
2. Add real-time status updates via WebSocket
3. Implement geolocation auto-filling from IP addresses
4. Add custom alerts/notifications for device status changes
5. Create dedicated admin dashboard for network topology
6. Implement historical data tracking for device movements
7. Add predictive visualization for network capacity planning
