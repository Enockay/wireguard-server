# Fix WireGuard Container on VPS

## Current Error:
The container is running without proper permissions. You need to run it with `--privileged` flag.

## Steps to Fix:

### 1. Stop and remove the current container:
```bash
docker stop wireguard
docker rm wireguard
```

### 2. Rebuild the image (since you updated the code):
```bash
cd /path/to/your/wireguard/project
docker build -t wireguard-vpn .
```

### 3. Run with --privileged flag:
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

### 4. Check the logs:
```bash
docker logs wireguard
```

You should now see:
- ✅ "WireGuard interface started successfully"
- ✅ "Starting WireGuard API..."
- ✅ "WireGuard API running on port 5000"

## Alternative: Using Docker Compose

If you created the docker-compose.yml file:

```bash
# Stop and remove old container
docker stop wireguard
docker rm wireguard

# Start with compose
docker-compose up -d

# Check logs
docker-compose logs -f wireguard
```

## Troubleshooting:

If you still get errors, try loading the WireGuard module on the host:
```bash
sudo modprobe wireguard
lsmod | grep wireguard  # Verify it's loaded
```

Then run the container with both privileged and caps:
```bash
docker run -d \
  --name wireguard \
  --privileged \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  --sysctl net.ipv4.ip_forward=1 \
  -p 51820:51820/udp \
  -p 5000:5000/tcp \
  --env-file .env \
  wireguard-vpn
```

