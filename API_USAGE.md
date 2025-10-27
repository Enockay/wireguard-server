# WireGuard Management API Usage

## API Endpoints

### 1. Generate New Client (Recommended - Like fly wireguard create)

**Endpoint:** `POST /generate-client`

Generates a complete WireGuard client configuration automatically.

**Request:**
```bash
curl -X POST http://YOUR_SERVER:5000/generate-client
```

**Response:**
```json
{
  "success": true,
  "message": "Client generated successfully",
  "config": "[Interface]\nPrivateKey = CLIENT_PRIVATE_KEY\nAddress = 10.0.0.6/32\n\n[Peer]\nPublicKey = SERVER_PUBLIC_KEY\nEndpoint = YOUR_SERVER:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25",
  "peerDetails": {
    "publicKey": "CLIENT_PUBLIC_KEY",
    "allowedIPs": "10.0.0.6/32",
    "serverPublicKey": "SERVER_PUBLIC_KEY",
    "serverEndpoint": "YOUR_SERVER:51820"
  }
}
```

**What it does:**
- ✅ Generates client private/public key pair
- ✅ Assigns next available IP (no duplicates)
- ✅ Adds peer to WireGuard
- ✅ Returns complete configuration file

**Save to file:**
```bash
curl -X POST http://YOUR_SERVER:5000/generate-client | jq -r '.config' > client.conf
```

---

### 2. List All Peers

**Endpoint:** `GET /list-peers`

**Request:**
```bash
curl http://YOUR_SERVER:5000/list-peers
```

**Response:**
```json
{
  "success": true,
  "peers": "WireGuard status output..."
}
```

---

### 3. Add Peer Manually

**Endpoint:** `POST /add-peer`

**Request:**
```bash
curl -X POST http://YOUR_SERVER:5000/add-peer \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "YOUR_PUBLIC_KEY",
    "allowedIPs": "10.0.0.6/32"
  }'
```

---

### 4. Health Check

**Endpoint:** `GET /`

**Request:**
```bash
curl http://YOUR_SERVER:5000/
```

---

## Setting Server Endpoint

Set the `SERVER_ENDPOINT` environment variable in your Docker container to automatically fill in the endpoint in generated configs:

```bash
docker run ... \
  -e SERVER_ENDPOINT="your-server.com:51820" \
  ...
```

Or in Coolify:
- Environment Variable: `SERVER_ENDPOINT`
- Value: `your-domain.com:51820`

---

## Complete Example

```bash
# Generate a new client
curl -X POST http://your-server:5000/generate-client \
  -H "Content-Type: application/json" \
  > client-config.json

# Extract the config
cat client-config.json | jq -r '.config' > client.conf

# Use on client device
# Linux/Mac: sudo wg-quick up client.conf
# Windows: Import client.conf into WireGuard GUI
```

---

## IP Assignment Rules

- ✅ Server: `10.0.0.1`
- ✅ Pre-configured peers: `10.0.0.2-5`
- ✅ Auto-assigned starting from: `10.0.0.6`
- ✅ No duplicate IPs
- ✅ Sequential assignment

