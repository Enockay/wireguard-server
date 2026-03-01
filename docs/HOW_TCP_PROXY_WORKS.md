# How TCP Proxy Works with Coolify

## Complete Flow: User → Router

### Example: User connects to Winbox via `vpn.blackie-networks.com:6733`

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User opens Winbox                                         │
│    Connects to: vpn.blackie-networks.com:6733               │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Coolify/Traefik (Public Proxy)                           │
│    Receives TCP connection on port 6733                      │
│    Forwards to: wireguard container:6733                    │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. WireGuard Container                                       │
│    Port 6733 is exposed (via docker-compose or Coolify)    │
│    Traffic goes to: wireguard-api container                 │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. TCP Proxy Service (in wireguard-api container)           │
│    Listens on: 0.0.0.0:6733                                 │
│    Forwards to: 10.0.0.6:8291 (MikroTik Winbox port)        │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. MikroTik Router (via WireGuard VPN)                      │
│    VPN IP: 10.0.0.6                                         │
│    Winbox port: 8291                                        │
│    ✅ Connection established!                               │
└─────────────────────────────────────────────────────────────┘
```

## What's Implemented

### ✅ TCP Proxy Service (`services/tcp-proxy-service.js`)

- Creates TCP proxy servers for each router
- Listens on allocated public ports (e.g., 6733)
- Forwards to router's VPN IP on standard ports:
  - Winbox: 8291
  - SSH: 22
  - API: 8728

### ✅ Automatic Proxy Management

- **On Router Creation**: Proxy automatically starts
- **On Server Restart**: All active router proxies are restored
- **On Router Deletion**: Proxy automatically stops
- **On Router Online**: Proxy ensures it's running

### ✅ Integration Points

1. **Router Creation** (`routes/mikrotik-routers.js`):
   - Creates router → Allocates ports → Starts proxy

2. **Server Startup** (`wireguard-api.js`):
   - Loads all active routers → Starts all proxies

3. **Router Status Monitoring**:
   - Checks router online status → Ensures proxy is running

## Port Allocation

### Port Ranges:
- **Winbox**: 3000-9999
- **SSH**: 10000-19999
- **API**: 20000-29999

### Example Allocation:
- Router "office-router" gets:
  - Winbox: 6733
  - SSH: 12345
  - API: 23456

## Coolify Configuration

### Important: Docker Compose Port Ranges

Docker Compose **does NOT support port ranges** like `3000-9999:3000-9999/tcp`.

### Solution: Coolify Port Management

1. **Option A: Let Coolify Handle Ports**
   - Remove port ranges from docker-compose.yml
   - Configure ports in Coolify UI as routers are created
   - TCP proxy still works (listens inside container)

2. **Option B: Use Coolify's Port Management**
   - Coolify can expose ports dynamically
   - Add ports via Coolify API or UI
   - TCP proxy service handles the forwarding

3. **Option C: Manual Port Configuration**
   - Add ports to docker-compose.yml individually
   - Not scalable for many routers

## Testing

### 1. Check Proxy Status

```bash
GET /api/admin/proxy/status
Authorization: Bearer <token>

Response:
{
  "success": true,
  "proxies": [
    {
      "routerId": "...",
      "winbox": { "port": 6733, "address": "0.0.0.0" },
      "ssh": { "port": 12345, "address": "0.0.0.0" },
      "api": { "port": 23456, "address": "0.0.0.0" }
    }
  ],
  "count": 1
}
```

### 2. Test Winbox Connection

```bash
# From your local machine
telnet vpn.blackie-networks.com 6733

# Should connect successfully
```

### 3. Test SSH Connection

```bash
ssh -p 12345 admin@vpn.blackie-networks.com
```

## How It Works with Coolify

### Coolify's Role:

1. **Receives** public traffic on `vpn.blackie-networks.com:6733`
2. **Routes** to WireGuard container (port 6733)
3. **TCP Proxy** inside container forwards to router

### What Coolify Needs:

- Port 6733 exposed (either via docker-compose or Coolify UI)
- TCP passthrough enabled (Coolify/Traefik handles this automatically)

### What Happens Automatically:

- ✅ TCP proxy starts when router is created
- ✅ Proxy listens on allocated ports
- ✅ Traffic forwarding works immediately
- ✅ Proxy stops when router is deleted

## Current Implementation Status

✅ **TCP Proxy Service**: Created and integrated
✅ **Automatic Proxy Start**: On router creation
✅ **Proxy Status API**: Available at `/api/admin/proxy/status`
✅ **Router Integration**: Proxies start/stop with routers
✅ **Server Startup**: All proxies restored on restart

⚠️ **Coolify Port Configuration**: Needs manual setup in Coolify UI

## Next Steps for Coolify

1. **Deploy the updated docker-compose.yml**
2. **In Coolify UI**, configure ports as routers are created
3. **Or** use Coolify's port management API to add ports dynamically
4. **Test** connection to a router via allocated port

The TCP proxy service is ready and will work once Coolify exposes the ports!
