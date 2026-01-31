# How the WireGuard Server Works

## Overview

Your WireGuard server acts as a **VPN hub** that connects all your other servers, devices, and clients together in a secure private network.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Your WireGuard Server                     │
│                  (vpn.blackie-networks.com)                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐         ┌──────────────────┐          │
│  │  WireGuard       │         │  API Server      │          │
│  │  Container       │◄────────┤  Container       │          │
│  │                  │         │                  │          │
│  │  - wg0 interface │         │  - Express API   │          │
│  │  - Port 51820/udp│         │  - Port 5000/tcp │          │
│  │  - VPN networking│         │  - Manages peers │          │
│  └──────────────────┘         └──────────────────┘          │
│         │                              │                       │
│         └──────────────┬──────────────┘                       │
│                        │                                       │
│                 ┌──────▼──────┐                                │
│                 │   MongoDB   │                                │
│                 │  (Storage)  │                                │
│                 └─────────────┘                                │
└─────────────────────────────────────────────────────────────┘
         │
         │ VPN Connection (UDP 51820)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Connected Clients                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  • Server 1 (10.0.0.6)  • Server 2 (10.0.0.7)              │
│  • MikroTik Router (10.0.0.8)  • Laptop (10.0.0.9)         │
│  • Phone (10.0.0.10)  • Any device...                       │
│                                                               │
│  All can communicate with each other through VPN            │
└─────────────────────────────────────────────────────────────┘
```

## How It Works: Step by Step

### 1. Server Startup

When you run `docker-compose up -d`:

1. **WireGuard Container** starts:
   - Loads `wg0.conf` with server private key
   - Creates `wg0` network interface
   - Listens on UDP port 51820 for incoming connections
   - Server IP: `10.0.0.1/24`

2. **API Container** starts:
   - Connects to MongoDB
   - Loads all enabled clients from database
   - Adds them to WireGuard: `wg set wg0 peer <publicKey> allowed-ips <ip>`
   - Starts Express API on port 5000

3. **MongoDB Container** starts:
   - Stores all client configurations
   - Persists data across restarts

### 2. Creating a New Client/Server Connection

When you want to connect a new server or device:

#### Option A: Via API (Automatic)

```bash
# Create a new client
curl -X POST http://vpn.blackie-networks.com:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "server-1", "notes": "Production server"}'
```

**What happens:**
1. API generates a key pair (private + public key)
2. Assigns next available IP (e.g., `10.0.0.6/32`)
3. Saves to MongoDB
4. Adds peer to WireGuard: `wg set wg0 peer <publicKey> allowed-ips 10.0.0.6/32`
5. Returns client config file (`.conf`)

#### Option B: Via API (MikroTik Router)

```bash
# Get MikroTik auto-config script
curl http://vpn.blackie-networks.com:5000/mt/server-1
```

**What happens:**
1. API finds or creates client record
2. Generates RouterOS script
3. Script auto-configures MikroTik when imported

### 3. Client Connects

When your server/device connects:

1. **Client** uses the config file:
   ```ini
   [Interface]
   PrivateKey = <client-private-key>
   Address = 10.0.0.6/32
   
   [Peer]
   PublicKey = <server-public-key>
   Endpoint = vpn.blackie-networks.com:51820
   AllowedIPs = 10.0.0.0/24
   ```

2. **WireGuard** establishes encrypted tunnel:
   - Client sends handshake to server (UDP 51820)
   - Server validates client's public key
   - Both sides exchange encrypted traffic

3. **Connection established:**
   - Client gets IP: `10.0.0.6`
   - Can communicate with server (`10.0.0.1`) and other clients
   - All traffic encrypted end-to-end

### 4. Ongoing Management

The API continuously:

- **Updates statistics** (every 30 seconds):
  - Reads `wg show wg0 dump`
  - Updates client records with:
    - Last handshake time
    - Data transferred (RX/TX)
    - Connection status

- **Monitors connections**:
  - WireGuard container checks status every 60 seconds
  - Restarts interface if needed

## Network Topology

```
Internet
   │
   ├─── VPN Server (10.0.0.1)
   │    └─── wg0 interface
   │         │
   │         ├─── Server 1 (10.0.0.6) ◄─── Can ping/reach
   │         ├─── Server 2 (10.0.0.7) ◄─── Can ping/reach
   │         ├─── MikroTik (10.0.0.8) ◄─── Can ping/reach
   │         └─── Laptop (10.0.0.9)  ◄─── Can ping/reach
   │
   └─── All devices can communicate with each other
        through the VPN (10.0.0.0/24 network)
```

## Key Features

### 1. Dynamic Peer Management
- Peers added/removed without restarting WireGuard
- Uses `wg set` commands (no config file editing)
- Changes take effect immediately

### 2. Persistent Storage
- All clients saved in MongoDB
- On restart, all enabled clients automatically re-added
- No manual configuration needed

### 3. Real-time Statistics
- Track connection status
- Monitor data usage per client
- See last connection time

### 4. Automatic IP Assignment
- Starts at `10.0.0.6` (1-5 reserved)
- Prevents IP conflicts
- Tracks used IPs in database

## Example: Connecting Multiple Servers

```bash
# Server 1
curl -X POST http://vpn.blackie-networks.com:5000/generate-client \
  -d '{"name": "prod-server-1"}' -o prod-server-1.conf

# Server 2  
curl -X POST http://vpn.blackie-networks.com:5000/generate-client \
  -d '{"name": "prod-server-2"}' -o prod-server-2.conf

# MikroTik Router
curl http://vpn.blackie-networks.com:5000/mt/mikrotik-router -o router.rsc
# Then import router.rsc into MikroTik
```

All three will:
- Get unique IPs (10.0.0.6, 10.0.0.7, 10.0.0.8)
- Connect to VPN server
- Be able to ping each other
- Access each other's services securely

## Benefits of Separated Architecture

1. **No Connection Drops:**
   - WireGuard runs independently
   - API restarts don't affect VPN connections
   - Clients stay connected

2. **Better Performance:**
   - WireGuard handles only networking
   - No HTTP overhead on VPN traffic
   - Dedicated resources for each service

3. **Easier Management:**
   - Monitor each service separately
   - Update API without touching VPN
   - Scale independently if needed

## Monitoring Connections

```bash
# View all connected peers
curl http://vpn.blackie-networks.com:5000/list-peers

# Get detailed statistics
curl http://vpn.blackie-networks.com:5000/api/admin/stats

# Check specific client
curl http://vpn.blackie-networks.com:5000/api/clients/server-1
```

## Summary

Your WireGuard server:
- ✅ Acts as a VPN hub connecting all your servers/devices
- ✅ Creates client configs automatically via API
- ✅ Manages peers dynamically (add/remove without restart)
- ✅ Stores everything in MongoDB (persistent)
- ✅ Tracks real-time connection statistics
- ✅ Runs in separated containers (stable, no drops)

All your servers connect **TO** this central VPN server, and can then communicate with each other securely through the VPN network.
