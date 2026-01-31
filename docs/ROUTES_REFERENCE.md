# WireGuard Server - Complete Routes & Functionalities Reference

**Base URL:** `http://YOUR_SERVER:5000`  
**API Version:** 2.0.0  
**Port:** 5000 (TCP)

---

## 📋 Table of Contents

1. [Core Functionalities](#core-functionalities)
2. [All Available Routes](#all-available-routes)
3. [Route Categories](#route-categories)
4. [Quick Reference](#quick-reference)

---

## 🎯 Core Functionalities

### 1. **Client Management**
- Create, read, update, delete clients
- Enable/disable clients
- Bulk operations
- Search and filtering
- Pagination support

### 2. **Configuration Generation**
- WireGuard `.conf` files for standard clients
- MikroTik RouterOS `.rsc` scripts
- Auto-configuration scripts with connectivity testing
- Short URLs for easy access

### 3. **Statistics & Monitoring**
- Real-time connection statistics
- Transfer data (RX/TX)
- Last handshake tracking
- Client connection status
- Background statistics updates (every 30 seconds)

### 4. **Database Persistence**
- MongoDB storage for all clients
- Automatic IP allocation
- Key generation and management
- Persistent client data

### 5. **WireGuard Integration**
- Dynamic peer management
- Automatic peer addition/removal
- Real-time WireGuard status
- Connection health monitoring

---

## 🛣️ All Available Routes

### **Client Management Routes (Modern API)**

#### 1. List All Clients (with pagination & filtering)
```
GET /api/clients
```
**Query Parameters:**
- `page` (number, default: 1) - Page number
- `limit` (number, default: 50) - Items per page
- `enabled` (boolean) - Filter by enabled status
- `search` (string) - Search in name, notes, or IP
- `sortBy` (string, default: 'createdAt') - Field to sort by
- `sortOrder` (string, default: 'desc') - 'asc' or 'desc'

**Example:**
```bash
GET /api/clients?page=1&limit=10&enabled=true&search=office
```

---

#### 2. Get Client Details
```
GET /api/clients/:name
```
**Query Parameters:**
- `includePrivateKey` (boolean, default: false) - Include private key

**Example:**
```bash
GET /api/clients/office-router?includePrivateKey=false
```

---

#### 3. Create New Client
```
POST /api/clients
```
**Request Body:**
```json
{
  "name": "new-client",
  "notes": "Client description",
  "interfaceName": "wireguard-new-client",
  "allowedIPs": "0.0.0.0/0",
  "endpoint": "server-ip:51820",
  "dns": "8.8.8.8, 1.1.1.1",
  "persistentKeepalive": 25,
  "enabled": true
}
```

**Example:**
```bash
POST /api/clients
Content-Type: application/json

{
  "name": "new-client",
  "notes": "New office client"
}
```

---

#### 4. Update Client (Full Update)
```
PUT /api/clients/:name
```
**Request Body:**
```json
{
  "notes": "Updated notes",
  "interfaceName": "wireguard-updated",
  "enabled": true,
  "ip": "10.0.0.10/32",
  "allowedIPs": "0.0.0.0/0",
  "endpoint": "server-ip:51820",
  "dns": "8.8.8.8",
  "persistentKeepalive": 30
}
```

**Example:**
```bash
PUT /api/clients/office-router
Content-Type: application/json

{
  "notes": "Updated description",
  "enabled": true
}
```

---

#### 5. Delete Client
```
DELETE /api/clients/:name
```

**Example:**
```bash
DELETE /api/clients/office-router
```

---

#### 6. Enable Client
```
POST /api/clients/:name/enable
```

**Example:**
```bash
POST /api/clients/office-router/enable
```

---

#### 7. Disable Client
```
POST /api/clients/:name/disable
```

**Example:**
```bash
POST /api/clients/office-router/disable
```

---

#### 8. Regenerate Client Keys
```
POST /api/clients/:name/regenerate
```

**Example:**
```bash
POST /api/clients/office-router/regenerate
```

---

#### 9. Bulk Delete Clients
```
POST /api/clients/bulk-delete
```
**Request Body:**
```json
{
  "names": ["client1", "client2", "client3"]
}
```

**Example:**
```bash
POST /api/clients/bulk-delete
Content-Type: application/json

{
  "names": ["old-client-1", "old-client-2"]
}
```

---

### **Configuration Routes**

#### 10. Get WireGuard Config File
```
GET /api/clients/:name/config
```
**Returns:** WireGuard `.conf` file (downloadable)

**Example:**
```bash
GET /api/clients/office-router/config
# Downloads: office-router.conf
```

---

#### 11. Get MikroTik Script
```
GET /api/clients/:name/mikrotik
```
**Query Parameters:**
- `iface` (string) - Custom interface name
- `subnet` (string) - Allowed subnet (default: 10.0.0.0/24)

**Returns:** MikroTik `.rsc` script (downloadable)

**Example:**
```bash
GET /api/clients/office-router/mikrotik?iface=wg-office&subnet=10.0.0.0/24
# Downloads: office-router.rsc
```

---

#### 12. Get MikroTik Auto-Config Script
```
GET /api/clients/:name/autoconfig
```
**Returns:** Enhanced MikroTik auto-config script with connectivity testing

**Example:**
```bash
GET /api/clients/office-router/autoconfig
# Downloads: office-router-autoconfig.rsc
```

---

#### 13. Short URL for MikroTik Auto-Config
```
GET /:name/configure
```
**Friendly URL for MikroTik routers**

**Example:**
```bash
GET /office-router/configure
# Can be used directly in MikroTik:
# /tool/fetch url="http://server:5000/office-router/configure" dst-path=wg-config.rsc
```

---

### **Utility Routes**

#### 14. Ping Remote Server
```
POST /api/clients/:name/ping
```
**Request Body:**
```json
{
  "target": "10.0.0.1",
  "count": 3
}
```

**Example:**
```bash
POST /api/clients/office-router/ping
Content-Type: application/json

{
  "target": "10.0.0.1",
  "count": 3
}
```

---

### **Admin & Statistics Routes**

#### 15. Get Admin Statistics
```
GET /api/admin/stats
```
**Returns:** Client counts, WireGuard status, connection details

**Example:**
```bash
GET /api/admin/stats
```

**Response:**
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
      "details": ["client1 - 10.0.0.6 - Last seen: 5 minutes ago"]
    },
    "recent": [...]
  }
}
```

---

#### 16. Health Check
```
GET /api/health
```
**Returns:** System health status

**Example:**
```bash
GET /api/health
```

---

#### 17. Root Endpoint (API Info)
```
GET /
```
**Returns:** List of all available endpoints

**Example:**
```bash
GET /
```

---

### **Legacy Routes (Backward Compatibility)**

#### 18. Generate Client (Legacy)
```
POST /generate-client
```
**Request Body:**
```json
{
  "name": "client-name",
  "notes": "Optional notes"
}
```
**Returns:** WireGuard `.conf` file directly

---

#### 19. Generate MikroTik Script (Legacy)
```
POST /generate-mikrotik
```
**Request Body:**
```json
{
  "name": "mikrotik-client",
  "notes": "Optional notes",
  "interfaceName": "wireguard-client",
  "allowedSubnet": "10.0.0.0/24"
}
```
**Returns:** MikroTik `.rsc` file directly

---

#### 20. Short URL for MikroTik Script
```
GET /mt/:name
```
**Query Parameters:**
- `notes` (string)
- `iface` (string)
- `subnet` (string)

**Example:**
```bash
GET /mt/office-router?iface=wg-office
```

---

#### 21. List Active Peers
```
GET /list-peers
```
**Returns:** Raw WireGuard peer information

**Example:**
```bash
GET /list-peers
```

---

#### 22. Add Peer Manually (Legacy)
```
POST /add-peer
```
**Request Body:**
```json
{
  "publicKey": "peer_public_key",
  "allowedIPs": "10.0.0.10/32"
}
```

---

#### 23. List Clients (Legacy)
```
GET /clients
```
**Returns:** All clients (no pagination)

---

#### 24. Get Client (Legacy)
```
GET /clients/:name
```
**Returns:** WireGuard `.conf` file directly

---

#### 25. Update Client (Legacy - PATCH)
```
PATCH /clients/:name
```
**Request Body:**
```json
{
  "enabled": true,
  "notes": "Updated notes"
}
```

---

#### 26. Delete Client (Legacy)
```
DELETE /clients/:name
```

---

#### 27. Reload Clients from Database
```
POST /reload
```
**Manually reload all enabled clients from database to WireGuard**

**Example:**
```bash
POST /reload
```

---

## 📊 Route Categories

### **Modern API Routes (Recommended)**
- `/api/clients` - Full CRUD operations
- `/api/clients/:name` - Client details
- `/api/clients/:name/config` - Config files
- `/api/clients/:name/mikrotik` - MikroTik scripts
- `/api/clients/:name/autoconfig` - Auto-config
- `/api/clients/:name/ping` - Connectivity test
- `/api/clients/:name/enable` - Enable client
- `/api/clients/:name/disable` - Disable client
- `/api/clients/:name/regenerate` - Regenerate keys
- `/api/clients/bulk-delete` - Bulk operations
- `/api/admin/stats` - Statistics
- `/api/health` - Health check

### **Legacy Routes (Still Supported)**
- `/generate-client` - Generate client
- `/generate-mikrotik` - Generate MikroTik
- `/mt/:name` - Short URL MikroTik
- `/list-peers` - List peers
- `/add-peer` - Add peer
- `/clients` - List clients
- `/clients/:name` - Get client
- `/clients/:name` (PATCH) - Update client
- `/clients/:name` (DELETE) - Delete client
- `/reload` - Reload database

### **Short URLs (User-Friendly)**
- `/:name/configure` - MikroTik auto-config (shortest)

---

## 🚀 Quick Reference

### **Most Common Operations**

```bash
# 1. Create a new client
POST /api/clients
Body: {"name": "client-name", "notes": "description"}

# 2. List all clients
GET /api/clients?page=1&limit=50

# 3. Download WireGuard config
GET /api/clients/client-name/config

# 4. Download MikroTik script
GET /api/clients/client-name/mikrotik

# 5. Enable/Disable client
POST /api/clients/client-name/enable
POST /api/clients/client-name/disable

# 6. Delete client
DELETE /api/clients/client-name

# 7. Get statistics
GET /api/admin/stats

# 8. Health check
GET /api/health
```

### **MikroTik Quick Setup**

```bash
# Option 1: Short URL (easiest)
GET /client-name/configure

# Option 2: Full auto-config
GET /api/clients/client-name/autoconfig

# Option 3: Compact script
GET /mt/client-name
```

### **Response Format**

**Success:**
```json
{
  "success": true,
  "message": "Operation completed",
  "data": { ... }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message",
  "details": "Additional details"
}
```

---

## 🔧 Features Summary

✅ **Client Management**
- Full CRUD operations
- Enable/disable clients
- Bulk delete
- Search and filter
- Pagination

✅ **Configuration Generation**
- WireGuard `.conf` files
- MikroTik RouterOS scripts
- Auto-configuration with testing
- Short URLs

✅ **Statistics & Monitoring**
- Real-time connection stats
- Transfer data (RX/TX)
- Last handshake tracking
- Background updates (30s interval)

✅ **Database Integration**
- MongoDB persistence
- Automatic IP allocation
- Key management
- Data validation

✅ **WireGuard Integration**
- Dynamic peer management
- Automatic sync
- Health monitoring
- Connection tracking

---

## 📝 Notes

- All client names are automatically converted to lowercase
- IP addresses are allocated automatically from `10.0.0.6/32` onwards
- Statistics are updated every 30 seconds in the background
- Private keys are excluded from responses by default (use `includePrivateKey=true` to include)
- CORS is enabled for specific origins (check code for allowed origins)
- Database must be initialized before most operations

---

## 🔐 Security Notes

⚠️ **Important:**
- Currently, the API does not require authentication
- In production, implement authentication (API keys, JWT, etc.)
- Private keys are sensitive - handle with care
- Use HTTPS in production
- Consider implementing rate limiting

---

**Last Updated:** Based on wireguard-api.js v2.0.0
