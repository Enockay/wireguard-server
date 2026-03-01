# TCP Proxy Setup for Coolify

## How It Works

When a user connects to `vpn.blackie-networks.com:6733` (Winbox), here's what happens:

```
User's Winbox Client
    ↓
vpn.blackie-networks.com:6733 (Public Port)
    ↓
Coolify/Traefik (TCP passthrough)
    ↓
WireGuard Container (Port 6733 exposed)
    ↓
TCP Proxy Service (running in wireguard-api container)
    ↓
MikroTik Router via VPN (10.0.0.6:8291)
```

## Architecture

The TCP proxy service runs **inside the `wireguard-api` container** and:
1. Listens on allocated public ports (e.g., 6733 for Winbox)
2. Forwards TCP traffic to the router's VPN IP on standard MikroTik ports:
   - **Winbox**: Port 8291
   - **SSH**: Port 22
   - **API**: Port 8728

## Docker Compose Configuration

The `docker-compose.yml` now exposes port ranges:

```yaml
ports:
  - "3000-9999:3000-9999/tcp"   # Winbox ports
  - "10000-19999:10000-19999/tcp" # SSH ports
  - "20000-29999:20000-29999/tcp" # API ports
```

## Coolify Configuration

### Option 1: Use Docker Compose Port Mapping (Recommended)

1. **In Coolify UI:**
   - Go to your WireGuard service
   - Settings → Ports
   - The ports are already defined in `docker-compose.yml`
   - Coolify will automatically expose them

2. **Port Ranges:**
   - Winbox: `3000-9999/tcp`
   - SSH: `10000-19999/tcp`
   - API: `20000-29999/tcp`

### Option 2: Manual Port Configuration in Coolify

If port ranges don't work, you can:
1. In Coolify, go to your service
2. Settings → Ports
3. Add individual ports as routers are created (not recommended for many routers)

### Option 3: Use Traefik TCP Configuration

If you need more control, configure Traefik for TCP routing:

```yaml
# In docker-compose.yml, add Traefik labels
labels:
  - "traefik.enable=true"
  - "traefik.tcp.routers.winbox.rule=HostSNI(`*`)"
  - "traefik.tcp.routers.winbox.entrypoints=winbox"
  - "traefik.tcp.services.winbox.loadbalancer.server.port=6733"
```

However, this is complex and the TCP proxy service is simpler.

## How the TCP Proxy Works

### When Router is Created:

1. Router gets allocated ports (e.g., Winbox: 6733, SSH: 12345, API: 23456)
2. TCP proxy service automatically starts listening on these ports
3. Proxy forwards:
   - `6733` → `10.0.0.6:8291` (Winbox)
   - `12345` → `10.0.0.6:22` (SSH)
   - `23456` → `10.0.0.6:8728` (API)

### When Router Connects:

1. Router connects via WireGuard VPN
2. Gets VPN IP (e.g., `10.0.0.6`)
3. TCP proxy already running, ready to forward traffic
4. User can immediately connect via `vpn.blackie-networks.com:6733`

### When Router is Deleted:

1. TCP proxy stops listening on those ports
2. Ports are released and can be reused

## Testing the Proxy

### Test Winbox Connection:

```bash
# From your local machine
telnet vpn.blackie-networks.com 6733
# Should connect to the proxy, which forwards to router
```

### Check Proxy Status:

```bash
# Via API
GET /api/admin/proxy/status
Authorization: Bearer <admin-token>

# Returns:
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

## Important Notes

1. **Port Ranges**: Docker port ranges (`3000-9999:3000-9999/tcp`) work in Docker Compose, but Coolify might need individual port configuration
2. **Network Mode**: The `wireguard-api` container uses `network_mode: "service:wireguard"`, so it shares the WireGuard container's network and can access VPN IPs
3. **Port Conflicts**: The proxy service handles port conflicts gracefully (logs warning if port already in use)
4. **Auto-Start**: Proxies automatically start when:
   - Router is created
   - Server restarts (loads all active routers)
   - Router comes online

## Troubleshooting

### Port Already in Use

If you see `EADDRINUSE` errors:
- Check if another service is using the port
- Restart the container to release ports
- Check proxy status: `GET /api/admin/proxy/status`

### Can't Connect to Router

1. Verify router is connected to VPN:
   ```bash
   wg show wg0
   ```

2. Check router VPN IP:
   ```bash
   GET /api/routers/:id
   ```

3. Test VPN connectivity:
   ```bash
   ping 10.0.0.6  # Router's VPN IP
   ```

4. Check proxy is running:
   ```bash
   GET /api/admin/proxy/status
   ```

### Coolify Port Issues

If Coolify doesn't expose the ports:
1. Check Coolify service settings
2. Verify port ranges in `docker-compose.yml`
3. Try adding ports manually in Coolify UI
4. Check Coolify logs for port binding errors

## Security Considerations

1. **Firewall**: Only expose necessary ports
2. **Authentication**: Consider adding authentication layer before proxy
3. **Rate Limiting**: Implement rate limiting on proxy connections
4. **Monitoring**: Monitor proxy connections for suspicious activity

## Future Enhancements

- Add authentication layer before proxy
- Implement connection logging
- Add rate limiting per router
- WebSocket support for Winbox
- SSL/TLS termination for SSH
