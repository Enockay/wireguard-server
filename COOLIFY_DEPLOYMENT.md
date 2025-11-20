# Coolify Deployment Guide for WireGuard VPN

## ⚠️ Important: Required Coolify Settings

WireGuard requires special privileges to create network interfaces. You **MUST** configure these in the Coolify UI:

### Step 1: Enable Privileged Mode

1. Go to your application in Coolify
2. Navigate to **Settings** → **Advanced**
3. Enable **"Privileged Mode"** or **"Run as Privileged"**
   - This is **REQUIRED** for WireGuard to work

### Step 2: Add Required Capabilities

In the same **Settings** → **Advanced** section, add these capabilities:

- `NET_ADMIN` - Required for network interface management
- `SYS_MODULE` - Required for kernel module operations

### Step 3: Configure Ports

Ensure these ports are exposed:

- **51820/UDP** - WireGuard VPN port
- **5000/TCP** - Management API port

### Step 4: Set Environment Variables

In **Settings** → **Environment Variables**, add:

```
WIREGUARD_PRIVATE_KEY=your_server_private_key_here
MONGO_URI=mongodb://your_mongo_connection_string
SERVER_ENDPOINT=your_server_public_ip:51820
```

### Step 5: Configure Sysctls (if available)

If Coolify allows sysctl configuration, add:

```
net.ipv4.ip_forward=1
net.ipv4.conf.all.forwarding=1
net.ipv6.conf.all.forwarding=1
```

## Alternative: Host Network Mode

If privileged mode is not available, you can try using **Host Network Mode**:

1. In Coolify UI → **Settings** → **Network**
2. Enable **"Host Network Mode"**
3. This allows the container to use the host's network stack directly

**Note:** Host network mode may have security implications and may not work in all Coolify deployments.

## Verification

After deploying with the correct settings, check the logs:

```bash
# In Coolify UI → Logs, you should see:
✅ WireGuard interface started successfully
✅ WireGuard API running on port 5000
```

If you still see "Operation not permitted" errors, the privileged mode or capabilities are not properly configured.

## Troubleshooting

### Error: "Operation not permitted"

**Solution:** Enable privileged mode in Coolify UI settings

### Error: "Cannot find device wg0"

**Solution:** Ensure `NET_ADMIN` and `SYS_MODULE` capabilities are added

### WireGuard starts but peers can't connect

**Solution:** 
1. Verify port 51820/UDP is exposed and accessible
2. Check firewall rules on the host
3. Verify `SERVER_ENDPOINT` environment variable is set correctly

### MongoDB connection issues

**Solution:**
1. Ensure MongoDB is accessible from the container
2. Check `MONGO_URI` environment variable format
3. If using Coolify's MongoDB service, use the internal service name

### Error: "Bind for 0.0.0.0:51820 failed: port is already allocated"

**Solution:** This error occurs when port 51820 is already in use by another container or process. To fix:

1. **SSH into your Coolify server** and run:
   ```bash
   # Find containers using port 51820
   docker ps --filter "publish=51820"
   
   # Or check all containers
   docker ps -a
   ```

2. **Stop and remove orphan containers:**
   ```bash
   # Stop any containers using the port
   docker stop $(docker ps -q --filter "publish=51820")
   
   # Remove orphan containers (Coolify may create these)
   docker container prune -f
   
   # Or remove specific orphan containers mentioned in logs
   docker rm -f <container-id-from-logs>
   ```

3. **If using Coolify's web interface:**
   - Go to your application in Coolify
   - Check for any stopped/old containers
   - Manually stop and remove them
   - Try deploying again

4. **Alternative: Use a different port temporarily:**
   - In Coolify UI → Settings → Ports
   - Change 51820 to a different port (e.g., 51821)
   - Update `SERVER_ENDPOINT` environment variable accordingly
   - Update firewall rules if needed

## Quick Checklist

- [ ] Privileged mode enabled
- [ ] `NET_ADMIN` capability added
- [ ] `SYS_MODULE` capability added
- [ ] Port 51820/UDP exposed
- [ ] Port 5000/TCP exposed
- [ ] `WIREGUARD_PRIVATE_KEY` environment variable set
- [ ] `MONGO_URI` environment variable set (if using MongoDB)
- [ ] `SERVER_ENDPOINT` environment variable set
- [ ] IP forwarding enabled (sysctls or host configuration)

## Notes

- Coolify may not automatically read `coolify.yml` - configure settings in the UI
- Some Coolify deployments may not support privileged mode - check with your provider
- If privileged mode is not available, consider deploying on a VPS with Docker directly

