# Quick Example: Generate WireGuard Client

This is like `fly wireguard create` - everything automated!

## Step 1: Generate Client

```bash
# Replace with your actual server URL
curl -X POST http://your-coolify-url:5000/generate-client
```

**Response:**
```json
{
  "success": true,
  "message": "Client generated successfully",
  "config": "[Interface]\nPrivateKey = wE7U1P...\nAddress = 10.0.0.6/32\n\n[Peer]\nPublicKey = SERVER_PUBLIC_KEY\nEndpoint = your-server.com:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25",
  "peerDetails": {
    "publicKey": "CLIENT_PUBLIC_KEY",
    "allowedIPs": "10.0.0.6/32",
    "serverPublicKey": "SERVER_PUBLIC_KEY",
    "serverEndpoint": "your-server.com:51820"
  }
}
```

## Step 2: Save Configuration

Save the config to a file:

```bash
curl -X POST http://your-coolify-url:5000/generate-client \
  | jq -r '.config' \
  > my-vpn.conf
```

Or manually copy the `config` field from the JSON response.

## Step 3: Import to Device

**Linux/Mac:**
```bash
sudo wg-quick up my-vpn.conf
```

**Windows:**
1. Open WireGuard GUI
2. Click "Import from file"
3. Select `my-vpn.conf`

**Android/iOS:**
1. Open WireGuard app
2. Tap "+" → Create from file
3. Select the saved config file

## That's It! 

You're now connected to the VPN!

---

## Features

✅ **Auto-generates** private/public key pair  
✅ **Assigns unique IP** (no duplicates)  
✅ **Registers with WireGuard** automatically  
✅ **Returns complete config** ready to import  
✅ **No manual configuration needed**  

---

## Multiple Clients

Just call the endpoint again for each new client:

```bash
# Client 1
curl -X POST http://your-server:5000/generate-client > client1.json

# Client 2  
curl -X POST http://your-server:5000/generate-client > client2.json

# Client 3
curl -X POST http://your-server:5000/generate-client > client3.json
```

Each will get a unique IP (10.0.0.6, 10.0.0.7, 10.0.0.8, etc.)

