# WireGuard MongoDB Integration

The WireGuard API now uses **MongoDB** for professional client management with persistent storage.

## Features

✅ **Professional Database** - MongoDB for reliable, scalable storage  
✅ **Named Clients** - Each client must have a unique name  
✅ **Enable/Disable** - Admin can enable or disable clients remotely  
✅ **Auto-Recovery** - Clients automatically reload on server startup  
✅ **Persistent Storage** - Client data survives restarts  
✅ **Notes Field** - Add notes/description for each client  

## Database Schema

```javascript
{
  name: String (required, unique, lowercase),
  ip: String (required, unique, format: 10.0.0.X/32),
  publicKey: String (required, unique),
  privateKey: String (required),
  enabled: Boolean (default: true),
  createdBy: String (default: 'system'),
  notes: String (optional),
  createdAt: Date (auto),
  updatedAt: Date (auto)
}
```

## API Endpoints

### 1. Generate New Client

**Endpoint:** `POST /generate-client`

**Body (required):**
```json
{
  "name": "john-laptop",
  "notes": "John's personal laptop"
}
```

**Example:**
```bash
curl -X POST http://135.237.154.32:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "john-laptop", "notes": "Personal laptop"}'
```

**Response:** WireGuard configuration file

**Note:** Name is **required** and must be unique!

### 2. List All Clients

**Endpoint:** `GET /clients`

**Example:**
```bash
curl http://135.237.154.32:5000/clients
```

**Response:**
```json
{
  "success": true,
  "clients": [
    {
      "name": "john-laptop",
      "ip": "10.0.0.8/32",
      "publicKey": "...",
      "enabled": true,
      "notes": "Personal laptop",
      "createdAt": "2025-10-27T09:00:00.000Z",
      "updatedAt": "2025-10-27T09:00:00.000Z"
    }
  ],
  "count": 1
}
```

### 3. Get Client Configuration

**Endpoint:** `GET /clients/:name`

**Example:**
```bash
curl http://135.237.154.32:5000/clients/john-laptop -o john-laptop.conf
```

**Response:** WireGuard configuration file

### 4. Update Client (Enable/Disable)

**Endpoint:** `PATCH /clients/:name`

**Enable a client:**
```bash
curl -X PATCH http://135.237.154.32:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

**Disable a client:**
```bash
curl -X PATCH http://135.237.154.32:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

**Update notes:**
```bash
curl -X PATCH http://135.237.154.32:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"notes": "Updated notes"}'
```

**Response:**
```json
{
  "success": true,
  "message": "Client \"john-laptop\" updated successfully",
  "client": {
    "name": "john-laptop",
    "ip": "10.0.0.8/32",
    "enabled": true,
    "notes": "Updated notes"
  }
}
```

### 5. Delete Client

**Endpoint:** `DELETE /clients/:name`

**Example:**
```bash
curl -X DELETE http://135.237.154.32:5000/clients/john-laptop
```

**Response:**
```json
{
  "success": true,
  "message": "Client \"john-laptop\" deleted successfully",
  "deletedClient": {
    "name": "john-laptop",
    "ip": "10.0.0.8/32"
  }
}
```

### 6. Reload All Clients

**Endpoint:** `POST /reload`

Manually reload all enabled clients from database to WireGuard.

**Example:**
```bash
curl -X POST http://135.237.154.32:5000/reload
```

> **Note:** This happens automatically on server startup!

## Deployment

### Using Docker Compose (Recommended)

The updated `docker-compose.yml` includes MongoDB:

```bash
docker-compose up -d
```

This will start:
- WireGuard container on ports 51820 (UDP) and 5000 (TCP)
- MongoDB container on port 27017
- Both containers in the same network

### MongoDB Connection String

Set `MONGO_URI` environment variable:

```bash
# In .env file
MONGO_URI=mongodb://localhost:27017/wireguard

# For Docker Compose (automatic)
MONGO_URI=mongodb://mongo:27017/wireguard
```

## Workflow Examples

### Create Multiple Clients

```bash
# Create client for John
curl -X POST http://135.237.154.32:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "john-laptop", "notes": "Personal laptop"}' > john.conf

# Create client for Mary
curl -X POST http://135.237.154.32:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "mary-phone", "notes": "Mobile phone"}' > mary.conf

# Create client for Bob
curl -X POST http://135.237.154.32:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "bob-desktop", "notes": "Desktop PC"}' > bob.conf
```

### Disable a Client (Suspension)

```bash
# Disable John's access
curl -X PATCH http://135.237.154.32:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Re-enable a Client

```bash
# Re-enable John's access
curl -X PATCH http://135.237.154.32:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### List All Clients

```bash
curl http://135.237.154.32:5000/clients | jq .
```

### Re-download Lost Client Config

```bash
curl http://135.237.154.32:5000/clients/john-laptop -o john-new.conf
```

## Server Startup

On server startup, the system automatically:

1. ✅ Connects to MongoDB
2. ✅ Loads all enabled clients from database
3. ✅ Applies them to WireGuard
4. ✅ Client configurations persist across restarts

## Benefits

- **Persistent Storage:** Clients survive server restarts
- **Admin Control:** Enable/disable without deleting
- **Professional:** MongoDB for enterprise-grade reliability
- **Scalable:** Supports hundreds of clients
- **Trackable:** Notes and timestamps for auditing
- **Secure:** Private keys encrypted at rest in database

## Monitoring

### Check Database Connection

```bash
curl http://135.237.154.32:5000/
```

Response shows database status:
```json
{
  "status": "running",
  "database": "connected",
  "service": "WireGuard VPN Management API"
}
```

### View Active Connections

```bash
curl http://135.237.154.32:5000/list-peers
```

