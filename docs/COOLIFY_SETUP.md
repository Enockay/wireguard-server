# Coolify Setup Guide for TCP Proxy

## Important Note About Port Ranges

Docker Compose **does NOT support port ranges** like `3000-9999:3000-9999/tcp`. 

You have two options:

### Option 1: Let Coolify Handle Ports (Recommended)

**Remove the port ranges from docker-compose.yml** and let Coolify expose ports dynamically:

1. **In Coolify UI:**
   - Go to your WireGuard service
   - Settings → Ports
   - Add ports as needed (or use Coolify's port management)

2. **The TCP proxy service will still work** - it listens on all allocated ports inside the container
3. **Coolify will route traffic** from public ports to container ports

### Option 2: Use iptables/nginx Stream (Advanced)

If you need port ranges, use a reverse proxy like nginx with stream module or configure iptables rules.

## How It Works in Coolify

### Current Flow:

```
User → vpn.blackie-networks.com:6733
    ↓
Coolify/Traefik (TCP passthrough)
    ↓
WireGuard Container (Port 6733)
    ↓
TCP Proxy Service (in wireguard-api container)
    ↓
MikroTik Router (10.0.0.6:8291 via VPN)
```

### What Happens:

1. **User creates router** → Gets port 6733 allocated
2. **TCP proxy starts** → Listens on port 6733 inside container
3. **Coolify exposes port** → Maps public port 6733 to container port 6733
4. **User connects** → `vpn.blackie-networks.com:6733` → Proxy → Router

## Coolify Configuration Steps

### Step 1: Update docker-compose.yml

Remove port ranges (they don't work in Docker Compose):

```yaml
ports:
  - "51820:51820/udp"
  - "${API_PORT:-5000}:5000/tcp"
  # Remove the port ranges - Coolify will handle them
```

### Step 2: Configure Coolify

1. **In Coolify UI**, go to your WireGuard service
2. **Settings → Ports**
3. **Add ports manually** as routers are created, OR
4. **Use Coolify's port management** to expose the port ranges

### Step 3: Alternative - Use Environment Variables

You can also configure Coolify to expose ports via environment variables or labels.

## Testing

After setup, test the connection:

```bash
# Test Winbox connection
telnet vpn.blackie-networks.com 6733

# Should connect to your MikroTik router
```

## Troubleshooting

### Port Not Accessible

1. Check if port is exposed in Coolify
2. Check TCP proxy status: `GET /api/admin/proxy/status`
3. Verify router is connected: `wg show wg0`
4. Check container logs: `docker logs wireguard-api`

### Port Already in Use

The TCP proxy handles this gracefully - check logs for `EADDRINUSE` warnings.
