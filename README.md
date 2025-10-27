# WireGuard VPN Server with Management API

This project runs a WireGuard VPN server with a REST API for managing peers dynamically.

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

**Option B: Using Docker Compose** (Easier management)

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  wireguard:
    build: .
    container_name: wireguard
    restart: unless-stopped
    privileged: true  # Required for WireGuard on most VPS systems
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.forwarding=1
      - net.ipv6.conf.all.forwarding=1
    ports:
      - "51820:51820/udp"
      - "5000:5000/tcp"
    env_file:
      - .env
```

Then run:
```bash
docker-compose up -d
```

## API Usage

The management API runs on port `5000` and provides endpoints to manage WireGuard clients.

### Generate New Client (Easy Method)

Generate a complete WireGuard client configuration automatically:

```bash
curl -X POST http://YOUR_SERVER:5000/generate-client
```

This returns a complete configuration file that users can save and import into their WireGuard app. See `API_USAGE.md` for detailed documentation.

### Available Endpoints

- `POST /generate-client` - Auto-generate complete client config (like `fly wireguard create`)
- `POST /add-peer` - Manually add a peer with your own keys
- `GET /list-peers` - View all connected peers
- `GET /` - Health check and endpoint list

## Check Status

```bash
# Check container logs
docker logs wireguard

# Or if using docker-compose
docker-compose logs -f wireguard
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
# Enter the container
docker exec -it wireguard bash

# Check WireGuard status
wg show
```

### View Logs
```bash
docker logs wireguard
```

