# WireGuard Server - Quick Routes Reference

**Base URL:** `http://YOUR_SERVER:5000`

## 📋 All Routes at a Glance

| Method | Route | Purpose | Category |
|--------|-------|---------|----------|
| **GET** | `/` | API information & endpoint list | Info |
| **GET** | `/api/health` | Health check | System |
| **GET** | `/api/admin/stats` | Get statistics | Admin |
| **GET** | `/api/clients` | List all clients (paginated) | Client |
| **GET** | `/api/clients/:name` | Get client details | Client |
| **GET** | `/api/clients/:name/config` | Download WireGuard config | Config |
| **GET** | `/api/clients/:name/mikrotik` | Download MikroTik script | Config |
| **GET** | `/api/clients/:name/autoconfig` | Download MikroTik auto-config | Config |
| **POST** | `/api/clients` | Create new client | Client |
| **PUT** | `/api/clients/:name` | Update client (full) | Client |
| **POST** | `/api/clients/:name/enable` | Enable client | Client |
| **POST** | `/api/clients/:name/disable` | Disable client | Client |
| **POST** | `/api/clients/:name/regenerate` | Regenerate client keys | Client |
| **POST** | `/api/clients/:name/ping` | Ping remote server | Utility |
| **DELETE** | `/api/clients/:name` | Delete client | Client |
| **POST** | `/api/clients/bulk-delete` | Delete multiple clients | Client |
| **GET** | `/:name/configure` | Short URL for MikroTik config | Config |
| **POST** | `/generate-client` | Generate client (legacy) | Legacy |
| **POST** | `/generate-mikrotik` | Generate MikroTik (legacy) | Legacy |
| **GET** | `/mt/:name` | Short URL MikroTik (legacy) | Legacy |
| **GET** | `/list-peers` | List active WireGuard peers | Legacy |
| **POST** | `/add-peer` | Add peer manually (legacy) | Legacy |
| **GET** | `/clients` | List clients (legacy, no pagination) | Legacy |
| **GET** | `/clients/:name` | Get client config (legacy) | Legacy |
| **PATCH** | `/clients/:name` | Update client (legacy) | Legacy |
| **DELETE** | `/clients/:name` | Delete client (legacy) | Legacy |
| **POST** | `/reload` | Reload clients from database | System |

---

## 🎯 Core Functionalities

### 1. **Client Management** ✅
- ✅ Create clients
- ✅ List clients (with pagination, search, filtering)
- ✅ Get client details
- ✅ Update clients
- ✅ Delete clients (single & bulk)
- ✅ Enable/disable clients
- ✅ Regenerate keys

### 2. **Configuration Generation** ✅
- ✅ WireGuard `.conf` files
- ✅ MikroTik RouterOS `.rsc` scripts
- ✅ Auto-configuration scripts
- ✅ Short URLs for easy access

### 3. **Statistics & Monitoring** ✅
- ✅ Real-time connection statistics
- ✅ Transfer data (RX/TX bytes)
- ✅ Last handshake tracking
- ✅ Connection status
- ✅ Background updates (every 30s)

### 4. **Database Features** ✅
- ✅ MongoDB persistence
- ✅ Automatic IP allocation (10.0.0.6+)
- ✅ Key generation
- ✅ Data validation
- ✅ Search & filtering

### 5. **WireGuard Integration** ✅
- ✅ Dynamic peer management
- ✅ Automatic sync with database
- ✅ Real-time status
- ✅ Connection health monitoring

---

## 🚀 Most Used Routes

### Create & Manage Clients
```bash
# Create client
POST /api/clients
{"name": "client-name", "notes": "description"}

# List clients
GET /api/clients?page=1&limit=50&enabled=true

# Get client details
GET /api/clients/client-name

# Update client
PUT /api/clients/client-name
{"notes": "updated", "enabled": true}

# Delete client
DELETE /api/clients/client-name
```

### Download Configurations
```bash
# WireGuard config
GET /api/clients/client-name/config

# MikroTik script
GET /api/clients/client-name/mikrotik

# MikroTik auto-config (shortest URL)
GET /client-name/configure
```

### Enable/Disable
```bash
# Enable
POST /api/clients/client-name/enable

# Disable
POST /api/clients/client-name/disable
```

### Statistics
```bash
# Get stats
GET /api/admin/stats

# Health check
GET /api/health
```

---

## 📊 Response Format

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

## 🔧 Query Parameters

### List Clients (`GET /api/clients`)
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 50)
- `enabled` - Filter by enabled status (true/false)
- `search` - Search in name, notes, or IP
- `sortBy` - Field to sort by (default: 'createdAt')
- `sortOrder` - 'asc' or 'desc' (default: 'desc')

### Get Client (`GET /api/clients/:name`)
- `includePrivateKey` - Include private key (default: false)

### MikroTik Script (`GET /api/clients/:name/mikrotik`)
- `iface` - Custom interface name
- `subnet` - Allowed subnet (default: 10.0.0.0/24)

---

## 📝 Notes

- All client names are automatically lowercased
- IPs are auto-allocated from `10.0.0.6/32`
- Statistics update every 30 seconds
- Private keys excluded by default
- CORS enabled for specific origins

---

**Total Routes:** 27  
**Modern API Routes:** 15  
**Legacy Routes:** 12
