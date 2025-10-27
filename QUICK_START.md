# Quick Start for VPS Deployment

## On Your VPS:

1. **Stop the current container (if running)**:
   ```bash
   docker stop wireguard
   docker rm wireguard
   ```

2. **Rebuild the image with the updated code**:
   ```bash
   docker build -t wireguard-vpn .
   ```

3. **Run with --privileged flag** (Required on most VPS systems):
   ```bash
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

4. **Or use Docker Compose** (Easier):
   ```bash
   docker-compose up -d
   ```

5. **Check if it's running**:
   ```bash
   docker logs wireguard
   ```

You should see:
- "WireGuard interface started successfully"
- "Starting WireGuard API..."
- "✅ WireGuard API running on port 5000"

## Alternative: Load WireGuard Module on Host

If you don't want to use --privileged flag, you can load the WireGuard kernel module on your VPS host:

```bash
sudo modprobe wireguard
```

Then run without --privileged:
```bash
docker run -d \
  --name wireguard \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  --sysctl net.ipv4.ip_forward=1 \
  -p 51820:51820/udp \
  -p 5000:5000/tcp \
  --env-file .env \
  wireguard-vpn
```

