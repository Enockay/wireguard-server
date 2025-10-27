# Adding WireGuard Clients

Your WireGuard server is running! Now you can add clients/peers.

## Quick Start

### Step 1: Generate a Client Key Pair

On your local machine or the client device, generate a key pair:

```bash
# Generate private key
wg genkey > client-private.key

# Generate public key
wg pubkey < client-private.key > client-public.key

# View the public key (you'll need this)
cat client-public.key
```

### Step 2: Get Your Server's Public Key

Your server's public key (from your wg0.conf or generate):

```bash
# On the server, view the public key
docker exec -it wireguard wg show wg0 public-key
```

Or if you have the private key, generate public key:
```bash
echo "AHda7jGcuWpO5mtz7KunI1qz5o3xqc0PsBigRpb7/kg=" | wg pubkey
```

### Step 3: Add Peer via API

```bash
curl -X POST http://YOUR_SERVER:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "CLIENT_PUBLIC_KEY_HERE",
    "allowedIPs": "10.0.0.6/32"
  }'
```

### Step 4: Create Client Configuration File

Create a file on the client (e.g., `client.conf`):

```ini
[Interface]
PrivateKey = YOUR_CLIENT_PRIVATE_KEY
Address = 10.0.0.6/32

[Peer]
PublicKey = YOUR_SERVER_PUBLIC_KEY
Endpoint = YOUR_SERVER_IP:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

### Step 5: Connect from Client

```bash
# Linux/Mac
sudo wg-quick up client.conf

# Windows
# Import the config into WireGuard GUI
```

## Testing Connection

After connecting:
```bash
# On client, check connection
wg show

# Test internet
curl ifconfig.me

# It should show your server's IP, not your real IP
```

## Server Status

Check your server status:
```bash
# View all connected peers
docker exec wireguard wg show

# Check WireGuard interface
docker exec wireguard ip addr show wg0
```

## Example: Adding Multiple Clients

Each client needs a unique IP:

- Client 1: `10.0.0.6/32` ✅ (peers 2-5 already taken)
- Client 2: `10.0.0.7/32`
- Client 3: `10.0.0.8/32`
- etc.

Just increment the last octet.

