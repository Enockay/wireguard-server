# WireGuard VPN Server + Management API

Self-hosted WireGuard server with a REST API, MongoDB persistence, and MikroTik auto-provisioning.

## Architecture

This setup uses **separated containers** to prevent connection drops:
- **wireguard**: Handles VPN networking only (runs WireGuard interface)
- **wireguard-api**: REST API server (shares WireGuard's network namespace)
- **mongo**: MongoDB database for client persistence

The API container uses `network_mode: "service:wireguard"` to share the WireGuard container's network stack, allowing it to manage WireGuard peers without interfering with VPN connections.

## Prerequisites

- Docker installed on your system
- A WireGuard private key (you can generate one if you don't have it)

## Quick Start

### 1. Set up your environment

Create a `.env` file with your WireGuard private key:

```bash
# Generate a private key if you don't have one
wg genkey > private.key

# Edit the .env file and paste your private key
# The .env file should look like:
# WIREGUARD_PRIVATE_KEY=YOUR_PRIVATE_KEY_HERE
```

**Note:** Make sure to add `.env` to `.gitignore` to keep your private key secure!

### 2. Build and Run with Docker

**EASIEST: Run the helper script** (Auto-configures everything)

On **Windows**:
```bash
docker-run.bat
```

On **Linux/Mac**:
```bash
chmod +x docker-run.sh
./docker-run.sh
```

This script will automatically:
- Build the image if needed
- Stop any existing container
- Start with correct privileged mode and all sysctl settings
- Show you the logs

---

**Option A: Manual Docker Run** (Recommended for VPS)

```bash
# Build the Docker image
docker build -t wireguard-vpn .

# Run the container with --privileged flag (Required!)
docker run -d \
  --name wireguard \
  --privileged \
  --sysctl net.ipv4.ip_forward=1 \
  --sysctl net.ipv4.conf.all.forwarding=1 \
  --sysctl net.ipv6.conf.all.forwarding=1 \
  -p 51820:51820/udp \
  -p 5000:5000/tcp \
  --env-file .env \
  wireguard-vpn
```

**Option B: Using Docker Compose** (Recommended - Separated Architecture)

The `docker-compose.yml` file is already configured with separated services:

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f wireguard      # VPN server
docker-compose logs -f wireguard-api  # API server
docker-compose logs -f mongo          # Database
```

The compose file includes:
- **wireguard**: VPN server container (privileged, handles networking)
- **wireguard-api**: API server (shares WireGuard's network namespace)
- **mongo**: MongoDB database

## API (Essential Endpoints)

- Generate and store client config:
```bash
curl -sS -X POST http://YOUR_SERVER:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name":"device-1","notes":"purpose"}' \
  -o device-1.conf
```

- Download existing client config:
```bash
curl -sS http://YOUR_SERVER:5000/clients/device-1 -o device-1.conf
```

- List peers:
```bash
curl -sS http://YOUR_SERVER:5000/list-peers
```

- MikroTik short script:
```bash
curl -sS "http://YOUR_SERVER:5000/mt/device-1" -o mt.rsc
```

## Check Status

```bash
# Check all container logs
docker-compose logs -f

# Check specific service
docker-compose logs -f wireguard      # VPN server
docker-compose logs -f wireguard-api # API server

# Or using docker directly
docker logs wireguard
docker logs wireguard-api
```

## Deployment to Fly.io

If you have the Fly.io CLI installed:

```bash
# Set the secret
fly secrets set WIREGUARD_PRIVATE_KEY="YOUR_PRIVATE_KEY"

# Deploy
fly deploy
```

## Configuration

- **WireGuard Port**: UDP 51820
- **API Port**: TCP 5000
- **VPN Network**: 10.0.0.0/24
- **Server IP**: 10.0.0.1

## Troubleshooting

### Permission Issues
The container needs `NET_ADMIN` capability to manage network interfaces.

### Check WireGuard Status
```bash
# Enter the WireGuard container
docker exec -it wireguard bash

# Check WireGuard status
wg show

# Or from API container (shares network namespace)
docker exec -it wireguard-api wg show wg0
```

### View Logs
```bash
docker logs wireguard
```

### VPS/Coolify Notes
- The `wireguard` container must run with `--privileged` or the host must have the WireGuard module loaded.
- The `wireguard-api` container shares the WireGuard container's network namespace, so it doesn't need privileged mode.
- Coolify: 
  - Expose ports `51820/udp` (WireGuard) and `5000/tcp` (API)
  - Set `wireguard` container to privileged mode
  - The compose file includes Coolify labels for automatic configuration
  - Environment variables: `WIREGUARD_PRIVATE_KEY`, `MONGO_URI`, `SERVER_ENDPOINT`

### Why Separated Containers?
Running WireGuard and the API in separate containers prevents connection drops because:
1. WireGuard handles only VPN networking (no HTTP overhead)
2. API server shares the network namespace but runs independently
3. If the API restarts, VPN connections remain stable
4. Better resource isolation and monitoring

