# WireGuard VPN Management API Documentation

Complete API reference for the WireGuard VPN Management System.

**Base URL:** `http://YOUR_SERVER:5000`

**API Version:** 2.0.0

---

## Table of Contents

1. [Authentication](#authentication)
2. [Client Management](#client-management)
3. [Configuration Endpoints](#configuration-endpoints)
4. [Admin Operations](#admin-operations)
5. [Statistics & Health](#statistics--health)
6. [Legacy Endpoints](#legacy-endpoints)
7. [Error Handling](#error-handling)
8. [Response Formats](#response-formats)

---

## Authentication

Currently, the API does not require authentication. **⚠️ Important:** In production, you should implement authentication (API keys, JWT tokens, etc.) to secure the API.

---

## Client Management

### List All Clients

Get a paginated list of all clients with filtering and search capabilities.

**Endpoint:** `GET /api/clients`

**Query Parameters:**
- `page` (number, default: 1) - Page number
- `limit` (number, default: 50) - Items per page
- `enabled` (boolean, optional) - Filter by enabled status
- `search` (string, optional) - Search in name, notes, or IP
- `sortBy` (string, default: 'createdAt') - Field to sort by
- `sortOrder` (string, default: 'desc') - 'asc' or 'desc'

**Example Request:**
```bash
GET /api/clients?page=1&limit=10&enabled=true&search=office
```

**Example Response:**
```json
{
  "success": true,
  "clients": [
    {
      "name": "office-router",
      "ip": "10.0.0.6/32",
      "publicKey": "abc123...",
      "enabled": true,
      "notes": "Main office router",
      "createdAt": "2025-11-20T10:00:00.000Z",
      "updatedAt": "2025-11-20T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "pages": 3
  }
}
```

---

### Get Client Details

Get detailed information about a specific client.

**Endpoint:** `GET /api/clients/:name`

**Path Parameters:**
- `name` (string, required) - Client name

**Query Parameters:**
- `includePrivateKey` (boolean, default: false) - Include private key in response

**Example Request:**
```bash
GET /api/clients/office-router?includePrivateKey=false
```

**Example Response:**
```json
{
  "success": true,
  "client": {
    "name": "office-router",
    "ip": "10.0.0.6/32",
    "publicKey": "abc123...",
    "enabled": true,
    "notes": "Main office router",
    "interfaceName": "wireguard-office-router",
    "endpoint": "157.245.40.199:51820",
    "createdAt": "2025-11-20T10:00:00.000Z",
    "updatedAt": "2025-11-20T10:00:00.000Z"
  }
}
```

---

### Create New Client

Create a new WireGuard client.

**Endpoint:** `POST /api/clients`

**Request Body:**
```json
{
  "name": "new-client",
  "notes": "Client description",
  "interfaceName": "wireguard-new-client",  // Optional
  "allowedSubnet": "10.0.0.0/24",          // Optional
  "enabled": true                           // Optional, default: true
}
```

**Example Request:**
```bash
POST /api/clients
Content-Type: application/json

{
  "name": "new-client",
  "notes": "New office client",
  "enabled": true
}
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"new-client\" created successfully",
  "client": {
    "name": "new-client",
    "ip": "10.0.0.7/32",
    "publicKey": "xyz789...",
    "enabled": true,
    "notes": "New office client",
    "createdAt": "2025-11-20T11:00:00.000Z"
  }
}
```

**Error Responses:**
- `400` - Missing required fields
- `409` - Client already exists
- `500` - Server error

---

### Update Client

Update client information (full update).

**Endpoint:** `PUT /api/clients/:name`

**Path Parameters:**
- `name` (string, required) - Client name

**Request Body:**
```json
{
  "notes": "Updated notes",
  "interfaceName": "wireguard-updated",
  "enabled": true
}
```

**Example Request:**
```bash
PUT /api/clients/office-router
Content-Type: application/json

{
  "notes": "Updated description",
  "enabled": true
}
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"office-router\" updated successfully",
  "client": {
    "name": "office-router",
    "ip": "10.0.0.6/32",
    "enabled": true,
    "notes": "Updated description"
  }
}
```

---

### Delete Client

Delete a client and remove it from WireGuard.

**Endpoint:** `DELETE /api/clients/:name`

**Path Parameters:**
- `name` (string, required) - Client name

**Example Request:**
```bash
DELETE /api/clients/office-router
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"office-router\" deleted successfully",
  "deletedClient": {
    "name": "office-router",
    "ip": "10.0.0.6/32"
  }
}
```

**Error Responses:**
- `404` - Client not found
- `500` - Server error

---

### Enable Client

Enable a disabled client.

**Endpoint:** `POST /api/clients/:name/enable`

**Path Parameters:**
- `name` (string, required) - Client name

**Example Request:**
```bash
POST /api/clients/office-router/enable
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"office-router\" enabled successfully",
  "client": {
    "name": "office-router",
    "enabled": true
  }
}
```

---

### Disable Client

Disable a client (removes from WireGuard but keeps in database).

**Endpoint:** `POST /api/clients/:name/disable`

**Path Parameters:**
- `name` (string, required) - Client name

**Example Request:**
```bash
POST /api/clients/office-router/disable
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"office-router\" disabled successfully",
  "client": {
    "name": "office-router",
    "enabled": false
  }
}
```

---

### Regenerate Client Keys

Regenerate private and public keys for a client.

**Endpoint:** `POST /api/clients/:name/regenerate`

**Path Parameters:**
- `name` (string, required) - Client name

**Example Request:**
```bash
POST /api/clients/office-router/regenerate
```

**Example Response:**
```json
{
  "success": true,
  "message": "Client \"office-router\" keys regenerated successfully",
  "client": {
    "name": "office-router",
    "publicKey": "new_key_abc123..."
  }
}
```

**Note:** After regenerating keys, the client must update their configuration file.

---

### Bulk Delete Clients

Delete multiple clients at once.

**Endpoint:** `POST /api/clients/bulk-delete`

**Request Body:**
```json
{
  "names": ["client1", "client2", "client3"]
}
```

**Example Request:**
```bash
POST /api/clients/bulk-delete
Content-Type: application/json

{
  "names": ["old-client-1", "old-client-2"]
}
```

**Example Response:**
```json
{
  "success": true,
  "message": "Deleted 2 client(s) successfully",
  "deleted": 2,
  "clients": [
    { "name": "old-client-1", "ip": "10.0.0.5/32" },
    { "name": "old-client-2", "ip": "10.0.0.6/32" }
  ]
}
```

**Error Responses:**
- `400` - Invalid request (empty array or missing names)
- `404` - No clients found
- `500` - Server error

---

## Configuration Endpoints

### Get WireGuard Config File

Download the WireGuard configuration file (.conf) for a client.

**Endpoint:** `GET /api/clients/:name/config`

**Path Parameters:**
- `name` (string, required) - Client name

**Example Request:**
```bash
GET /api/clients/office-router/config
```

**Response:** 
- Content-Type: `text/plain`
- Content-Disposition: `attachment; filename="office-router.conf"`

**Example Response Body:**
```
[Interface]
PrivateKey = client_private_key_here
Address = 10.0.0.6/32

[Peer]
PublicKey = server_public_key_here
Endpoint = 157.245.40.199:51820
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
```

---

### Get MikroTik Script

Download the MikroTik RouterOS configuration script (.rsc) for a client.

**Endpoint:** `GET /api/clients/:name/mikrotik`

**Path Parameters:**
- `name` (string, required) - Client name

**Query Parameters:**
- `iface` (string, optional) - Custom interface name
- `subnet` (string, optional) - Allowed subnet (default: 10.0.0.0/24)

**Example Request:**
```bash
GET /api/clients/office-router/mikrotik?iface=wg-office&subnet=10.0.0.0/24
```

**Response:**
- Content-Type: `text/plain`
- Content-Disposition: `attachment; filename="office-router.rsc"`

**Example Response Body:**
```
:local IFACE "wg-office";:local PRIV "private_key";...
```

---

## Admin Operations

### Get Statistics

Get system statistics including client counts and WireGuard status.

**Endpoint:** `GET /api/admin/stats`

**Example Request:**
```bash
GET /api/admin/stats
```

**Example Response:**
```json
{
  "success": true,
  "stats": {
    "clients": {
      "total": 25,
      "enabled": 20,
      "disabled": 5
    },
    "wireguard": {
      "connected": 18,
      "details": [
        "peer1...",
        "peer2..."
      ]
    },
    "recent": [
      {
        "name": "new-client",
        "ip": "10.0.0.7/32",
        "enabled": true,
        "createdAt": "2025-11-20T11:00:00.000Z"
      }
    ]
  }
}
```

---

### Health Check

Check API and system health status.

**Endpoint:** `GET /api/health`

**Example Request:**
```bash
GET /api/health
```

**Example Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-11-20T11:00:00.000Z",
  "service": "WireGuard VPN Management API",
  "database": "connected",
  "wireguard": "running"
}
```

**Status Codes:**
- `200` - Healthy
- `503` - Unhealthy (database or WireGuard issues)

---

## Legacy Endpoints

These endpoints are maintained for backward compatibility but may be deprecated in future versions.

### Generate Client (Legacy)

**Endpoint:** `POST /generate-client`

**Request Body:**
```json
{
  "name": "client-name",
  "notes": "Optional notes"
}
```

**Response:** Returns WireGuard .conf file directly

---

### Generate MikroTik Script (Legacy)

**Endpoint:** `POST /generate-mikrotik`

**Request Body:**
```json
{
  "name": "mikrotik-client",
  "notes": "Optional notes",
  "interfaceName": "wireguard-client",
  "allowedSubnet": "10.0.0.0/24"
}
```

**Response:** Returns MikroTik .rsc file directly

---

### Get MikroTik Script (Short URL)

**Endpoint:** `GET /mt/:name`

**Query Parameters:**
- `notes` (string, optional)
- `iface` (string, optional)
- `subnet` (string, optional)

**Example:**
```bash
GET /mt/office-router?iface=wg-office
```

---

### List Active Peers

Get list of currently connected WireGuard peers.

**Endpoint:** `GET /list-peers`

**Example Request:**
```bash
GET /list-peers
```

**Example Response:**
```json
{
  "success": true,
  "peers": "interface: wg0\n  public key: abc123...\n  ..."
}
```

---

## Error Handling

All endpoints follow a consistent error response format:

```json
{
  "success": false,
  "error": "Error message",
  "details": "Detailed error information (optional)"
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request (missing/invalid parameters)
- `404` - Not Found
- `409` - Conflict (duplicate resource)
- `500` - Internal Server Error
- `503` - Service Unavailable (database/WireGuard not available)

---

## Response Formats

### Success Response

```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": { ... }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error description",
  "details": "Additional error details"
}
```

### Pagination Response

```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "pages": 10
  }
}
```

---

## Frontend Integration Examples

### JavaScript/TypeScript (Fetch API)

```javascript
// List clients
const response = await fetch('http://YOUR_SERVER:5000/api/clients?page=1&limit=10');
const data = await response.json();

// Create client
const newClient = await fetch('http://YOUR_SERVER:5000/api/clients', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'new-client',
    notes: 'Client description',
    enabled: true
  })
});

// Delete client
await fetch('http://YOUR_SERVER:5000/api/clients/office-router', {
  method: 'DELETE'
});

// Download config
const configResponse = await fetch('http://YOUR_SERVER:5000/api/clients/office-router/config');
const configBlob = await configResponse.blob();
const url = window.URL.createObjectURL(configBlob);
const a = document.createElement('a');
a.href = url;
a.download = 'office-router.conf';
a.click();
```

### Axios Example

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://YOUR_SERVER:5000/api'
});

// List clients
const clients = await api.get('/clients', {
  params: { page: 1, limit: 10, enabled: true }
});

// Create client
const newClient = await api.post('/clients', {
  name: 'new-client',
  notes: 'Description',
  enabled: true
});

// Update client
await api.put('/clients/office-router', {
  notes: 'Updated notes',
  enabled: true
});

// Delete client
await api.delete('/clients/office-router');

// Get statistics
const stats = await api.get('/admin/stats');
```

### React Hook Example

```javascript
import { useState, useEffect } from 'react';
import axios from 'axios';

function useClients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchClients = async () => {
      try {
        const response = await axios.get('http://YOUR_SERVER:5000/api/clients');
        setClients(response.data.clients);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchClients();
  }, []);

  const createClient = async (clientData) => {
    const response = await axios.post('http://YOUR_SERVER:5000/api/clients', clientData);
    setClients([...clients, response.data.client]);
    return response.data;
  };

  const deleteClient = async (name) => {
    await axios.delete(`http://YOUR_SERVER:5000/api/clients/${name}`);
    setClients(clients.filter(c => c.name !== name));
  };

  return { clients, loading, error, createClient, deleteClient };
}
```

---

## Best Practices

1. **Error Handling:** Always check the `success` field in responses
2. **Pagination:** Use pagination for large client lists
3. **Loading States:** Show loading indicators during API calls
4. **Validation:** Validate input on the frontend before sending requests
5. **Caching:** Consider caching statistics and client lists
6. **Retry Logic:** Implement retry logic for failed requests
7. **Security:** Never expose private keys in the UI (use `includePrivateKey=false`)

---

## Rate Limiting

Currently, there is no rate limiting implemented. Consider implementing rate limiting in production to prevent abuse.

---

## Support

For issues or questions, please refer to the main project documentation or create an issue in the repository.

