# TCP Proxy Debugging Guide

## Enhanced Debugging Features

The TCP proxy service now includes comprehensive logging and debugging tools to help diagnose connection issues.

## New Debugging Features

### 1. Enhanced Logging

The proxy service now logs:
- **Connection received**: When a client connects to the proxy
- **Target connection**: When proxy connects to the router
- **Data flow**: Bytes forwarded and received
- **Connection errors**: Detailed error messages with error codes
- **Connection close**: When connections are closed

### 2. Proxy Status API

**Endpoint**: `GET /api/admin/proxy/status`

Returns detailed status for all active proxies:

```json
{
  "success": true,
  "proxies": [...],
  "detailedStatus": [
    {
      "routerId": "...",
      "routerName": "ChukaMikrotik",
      "vpnIp": "10.0.0.23",
      "ports": {
        "winbox": 1000,
        "ssh": 3334,
        "api": 6667
      },
      "proxyStatus": {
        "running": true,
        "winbox": {
          "listening": true,
          "address": { "address": "0.0.0.0", "port": 1000 }
        },
        "ssh": { ... },
        "api": { ... }
      }
    }
  ],
  "count": 2,
  "totalRouters": 2
}
```

### 3. Test Proxy Connection API

**Endpoint**: `POST /api/admin/proxy/test`

Test if the proxy can connect to a router:

```bash
curl -X POST http://localhost:5000/api/admin/proxy/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "routerId": "69a2ad6ff828c424f83abd72",
    "portType": "winbox"
  }'
```

Response:
```json
{
  "success": true,
  "routerId": "...",
  "portType": "winbox",
  "result": {
    "success": true,
    "target": "10.0.0.23:8291"
  }
}
```

## Common Issues and Solutions

### Issue 1: Proxy Not Working - Ports Not Exposed

**Symptoms:**
- Proxy logs show "proxy_server_listening"
- But connections from outside fail
- `netstat` or `ss` shows ports not listening

**Cause:**
- Ports are not exposed from Docker container to host
- Coolify not configured to expose the ports

**Solution:**
1. **Check if ports are listening inside container:**
   ```bash
   docker exec wireguard-api netstat -tlnp | grep -E ':(1000|3334|6667)'
   ```

2. **Check Coolify port configuration:**
   - Go to Coolify UI → Your service → Settings → Ports
   - Ensure ports 1000, 3334, 6667 (and others) are exposed
   - Ports should be TCP, not UDP

3. **Check docker-compose.yml:**
   - Since `wireguard-api` uses `network_mode: "service:wireguard"`, ports need to be exposed in the `wireguard` service
   - Add ports to `wireguard` service in docker-compose.yml:
     ```yaml
     ports:
       - "1000:1000/tcp"  # Winbox
       - "3334:3334/tcp"  # SSH
       - "6667:6667/tcp"  # API
     ```

### Issue 2: Proxy Can't Connect to Router

**Symptoms:**
- Proxy receives connections
- But logs show "proxy_target_connection_failed"
- Error: `ECONNREFUSED` or `EHOSTUNREACH`

**Cause:**
- Router not connected to VPN
- Router VPN IP changed
- Router firewall blocking connections

**Solution:**
1. **Check router is connected:**
   ```bash
   wg show wg0
   # Should show peer with router's public key
   ```

2. **Test router connectivity:**
   ```bash
   ping 10.0.0.23  # Router VPN IP
   ```

3. **Test router ports:**
   ```bash
   telnet 10.0.0.23 8291  # Winbox
   telnet 10.0.0.23 22    # SSH
   telnet 10.0.0.23 8728  # API
   ```

4. **Use test endpoint:**
   ```bash
   curl -X POST http://localhost:5000/api/admin/proxy/test \
     -H "Content-Type: application/json" \
     -d '{"routerId": "...", "portType": "winbox"}'
   ```

### Issue 3: Port Already in Use

**Symptoms:**
- Logs show "proxy_port_in_use"
- Error: `EADDRINUSE`

**Cause:**
- Another service using the port
- Previous proxy instance didn't close properly

**Solution:**
1. **Find what's using the port:**
   ```bash
   netstat -tlnp | grep 1000
   # or
   lsof -i :1000
   ```

2. **Restart the container:**
   ```bash
   docker restart wireguard-api
   ```

3. **Check for duplicate proxy instances:**
   - Review logs for multiple "proxy_server_started" messages
   - Ensure `stopRouterProxy` is called before `startRouterProxy`

### Issue 4: Connections Timeout

**Symptoms:**
- Client connects to proxy
- But connection hangs or times out
- No data flows

**Cause:**
- Router not responding
- Network issues
- Firewall blocking

**Solution:**
1. **Check proxy logs for connection details:**
   - Look for "proxy_connection_received"
   - Check if "proxy_target_connected" appears
   - Review error messages

2. **Test direct connection to router:**
   ```bash
   # From inside the container
   telnet 10.0.0.23 8291
   ```

3. **Check router status:**
   - Use ping endpoint: `GET /api/clients/:name/ping`
   - Check router status in dashboard

## Debugging Steps

### Step 1: Check Proxy Status

```bash
curl http://localhost:5000/api/admin/proxy/status | jq
```

Look for:
- `running: true` for each proxy
- `listening: true` for each port
- Correct `vpnIp` addresses

### Step 2: Check Logs

```bash
docker logs wireguard-api | grep proxy
```

Look for:
- `proxy_server_listening` - Proxy started successfully
- `proxy_connection_received` - Client connected
- `proxy_target_connected` - Connected to router
- `proxy_target_connection_failed` - Cannot reach router

### Step 3: Test Port Listening

```bash
# Inside container
docker exec wireguard-api netstat -tlnp | grep -E ':(1000|3334|6667)'

# From host
netstat -tlnp | grep -E ':(1000|3334|6667)'
```

### Step 4: Test Router Connectivity

```bash
# Test ping
curl http://localhost:5000/api/clients/router-name/ping

# Test proxy connection
curl -X POST http://localhost:5000/api/admin/proxy/test \
  -H "Content-Type: application/json" \
  -d '{"routerId": "...", "portType": "winbox"}'
```

### Step 5: Test End-to-End Connection

```bash
# From your local machine
telnet vpn.blackie-networks.com 1000
# Should connect (if port is exposed)

# Or use Winbox
# Connect to: vpn.blackie-networks.com:1000
```

## Log Messages Reference

### Success Messages:
- `proxy_server_listening` - Proxy server started and listening
- `proxy_connection_received` - Client connected to proxy
- `proxy_target_connected` - Proxy connected to router
- `proxy_test_success` - Test connection succeeded

### Error Messages:
- `proxy_port_in_use` - Port already in use (EADDRINUSE)
- `proxy_target_connection_failed` - Cannot connect to router
  - Common codes: `ECONNREFUSED`, `EHOSTUNREACH`, `ETIMEDOUT`
- `proxy_client_error` - Client connection error
- `proxy_server_error` - Server error

## Quick Debug Checklist

- [ ] Proxy status shows `running: true`
- [ ] Ports are listening (`netstat` shows ports)
- [ ] Ports are exposed in Docker/Coolify
- [ ] Router is connected to VPN (`wg show wg0`)
- [ ] Can ping router VPN IP
- [ ] Can connect to router ports directly
- [ ] Test endpoint returns `success: true`
- [ ] No `EADDRINUSE` errors in logs
- [ ] No `ECONNREFUSED` errors in logs

## Getting Help

If issues persist:
1. Collect logs: `docker logs wireguard-api > proxy-debug.log`
2. Get proxy status: `curl http://localhost:5000/api/admin/proxy/status | jq > proxy-status.json`
3. Test connection: `curl -X POST http://localhost:5000/api/admin/proxy/test ...`
4. Check router status: `curl http://localhost:5000/api/mikrotik-routers/:id`
