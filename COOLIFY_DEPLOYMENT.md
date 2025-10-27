# Deploying WireGuard on Coolify

## Problem
Coolify by default doesn't run containers with privileged mode, which WireGuard requires.

## Solution Options

### Option 1: Configure Coolify to Use Privileged Mode (Recommended)

After your app deploys on Coolify:

1. Go to your application settings in Coolify
2. Find **"Docker Run Command"** or **"Additional Docker Arguments"**
3. Add these settings:

```bash
--privileged \
--sysctl net.ipv4.ip_forward=1 \
--sysctl net.ipv4.conf.all.forwarding=1 \
--sysctl net.ipv6.conf.all.forwarding=1
```

4. Save and redeploy

### Option 2: Use Docker Compose with Network Mode

If Coolify supports docker-compose.yml:

1. Make sure your `docker-compose.yml` has:
   - `privileged: true`
   - `network_mode: host` (if supported by Coolify)

2. Push the updated `docker-compose.yml` to your repo

### Option 3: Load WireGuard Module on Host (Server-Level Fix)

SSH into your Coolify host server and run:

```bash
sudo modprobe wireguard
sudo lsmod | grep wireguard  # Verify it loaded
```

Then in Coolify:
1. Add these Docker run arguments:
   ```bash
   --cap-add=NET_ADMIN --cap-add=SYS_MODULE
   ```

2. Set these sysctls in Coolify:
   ```bash
   --sysctl net.ipv4.ip_forward=1
   ```

### Current Status After Update

The updated `run.sh` now:
- ✅ **Won't crash** if WireGuard fails to start
- ✅ **Still starts the API** on port 5000
- ✅ **Shows clear warnings** about WireGuard status
- ✅ **Retries WireGuard** every 60 seconds

This means you can now:
1. Deploy successfully (API will start)
2. Test the API at `http://your-coolify-url:5000`
3. Configure privileged mode when ready
4. WireGuard will auto-start once permissions are correct

## Coolify Environment Variables

Make sure you set in Coolify:
- `WIREGUARD_PRIVATE_KEY` = Your WireGuard private key

Set this in: Coolify → Your App → Environment Variables

## Testing the API

Once deployed, even without WireGuard working:

```bash
# Add a peer (this will work when WireGuard starts)
curl -X POST http://your-domain:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "PEER_PUBLIC_KEY",
    "allowedIPs": "10.0.0.6/32"
  }'
```

The API will respond and queue the peer for when WireGuard becomes available.

