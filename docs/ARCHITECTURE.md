# Architecture: Separated Containers

## Overview

The WireGuard server has been refactored to use **separated containers** to prevent connection drops and improve stability.

## Container Structure

### 1. `wireguard` Container
- **Purpose**: Handles WireGuard VPN networking only
- **Image**: Built from `Dockerfile.wireguard`
- **Privileges**: Requires `--privileged` mode
- **Ports**: 
  - `51820/udp` (WireGuard VPN)
  - `5000/tcp` (API, exposed through this container)
- **Network**: Own network namespace (shared with API container)

### 2. `wireguard-api` Container
- **Purpose**: REST API for managing WireGuard clients
- **Image**: Built from `Dockerfile.api`
- **Network Mode**: `network_mode: "service:wireguard"`
  - Shares WireGuard container's network namespace
  - Can access `wg0` interface directly
  - No privileged mode needed
- **Ports**: Uses WireGuard container's port 5000

### 3. `mongo` Container
- **Purpose**: MongoDB database for client persistence
- **Image**: `mongo:latest`
- **Ports**: `27017/tcp`

## Why This Architecture?

### Problem with Single Container
- Running WireGuard and HTTP server in one container causes:
  - Connection drops when API restarts
  - Resource contention
  - Difficult to scale independently

### Solution: Separated Containers
- **Stability**: VPN connections remain active even if API restarts
- **Isolation**: Each service has its own process space
- **Network Sharing**: API uses `network_mode: "service:wireguard"` to access WireGuard interface
- **Monitoring**: Can monitor each service independently

## Network Flow

```
Internet
   ↓
[WireGuard Container: Port 51820/udp]
   ├── wg0 interface (VPN networking)
   └── Port 5000/tcp (exposed to host)
       ↓
[API Container: network_mode: service:wireguard]
   └── Express.js API (shares WireGuard's network)
       ↓
[MongoDB Container]
   └── Client data storage
```

## Key Files

- `Dockerfile.wireguard` - WireGuard-only container
- `Dockerfile.api` - API-only container  
- `run-wireguard.sh` - WireGuard startup script
- `run-api.sh` - API startup script
- `docker-compose.yml` - Orchestrates all services

## Migration from Single Container

If you were using the old single-container setup:

1. **Stop old container**:
   ```bash
   docker-compose down
   # or
   docker stop wireguard
   ```

2. **Use new compose file**:
   ```bash
   docker-compose up -d
   ```

3. **Verify services**:
   ```bash
   docker-compose ps
   docker-compose logs -f wireguard
   docker-compose logs -f wireguard-api
   ```

## Environment Variables

Required in `.env` or Coolify:
- `WIREGUARD_PRIVATE_KEY` - WireGuard server private key
- `MONGO_URI` - MongoDB connection string (default: `mongodb://mongo:27017/wireguard`)
- `SERVER_ENDPOINT` - Server IP/domain for client configs (e.g., `vpn.example.com:51820`)

Optional:
- `API_PORT` - API port (default: `5000`)
- `TZ` - Timezone (default: `UTC`)
- `NODE_ENV` - Node environment (default: `production`)
