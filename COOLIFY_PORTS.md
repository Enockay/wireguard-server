# Port Configuration for Coolify

## Required Ports

### Port 51820 (UDP) - WireGuard VPN
- **Protocol**: UDP
- **Purpose**: WireGuard VPN connections
- **Who connects**: Your VPN clients
- **Required**: YES

### Port 5000 (TCP) - Management API
- **Protocol**: TCP  
- **Purpose**: REST API to add/manage peers
- **Who connects**: You (for management)
- **Required**: YES (but can be restricted to internal only)

## How to Configure in Coolify

1. Go to your application in Coolify
2. Find **"Ports"** or **"Exposed Ports"** section
3. Add these two ports:

```
Port 51820 (UDP)
Port 5000 (TCP)
```

4. Set the "Service Port" to match the container ports

## Recommended Port Restrictions

- **Port 51820**: Must be publicly accessible (for VPN clients)
- **Port 5000**: 
  - Option A: Public (easier for testing)
  - Option B: Private/internal only (more secure)

## Client Configuration

Your WireGuard clients need:
- **Server IP**: Your Coolify domain or IP
- **Port**: 51820 (UDP)

## Testing

After deployment:
```bash
# Test API (replace with your domain)
curl http://your-coolify-domain:5000

# Add a peer
curl -X POST http://your-coolify-domain:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "CLIENT_PUBLIC_KEY",
    "allowedIPs": "10.0.0.6/32"
  }'
```

## Firewall Rules (if configuring at host level)

```bash
# Allow WireGuard
sudo ufw allow 51820/udp

# Allow API (optional, only if needed)
sudo ufw allow 5000/tcp
```

