# Server Status

## ✅ Your WireGuard Server is Running!

### Configuration Summary:
- **WireGuard Port**: 51820 (UDP)
- **Management API**: 5000 (TCP)
- **Server IP**: 10.0.0.1
- **VPN Network**: 10.0.0.0/24

### Pre-configured Peers:
From your `wg0.conf`, you have 4 peers already configured:
- 10.0.0.2/32
- 10.0.0.3/32
- 10.0.0.4/32 (used as default gateway in PostUp)
- 10.0.0.5/32

## Quick Commands

### View Server Status
```bash
# List all peers and their connection status
docker exec wireguard wg show

# View server public key
docker exec wireguard wg show wg0 public-key

# View server listening port
docker exec wireguard wg show wg0 listen-port
```

### Server Logs
```bash
# View real-time logs
docker logs -f wireguard

# View last 100 lines
docker logs --tail 100 wireguard
```

### Test API
```bash
# Replace with your actual URL
curl http://your-domain:5000
```

## Adding New Clients

See `ADD_CLIENT.md` for detailed instructions.

## Server Information

- **Server Private Key**: Set in .env file
- **Server Public Key**: Run `docker exec wireguard wg show wg0 public-key`
- **Endpoint**: Your server's IP:51820

## Monitoring

The container automatically:
- ✅ Restarts WireGuard if it goes down
- ✅ Checks peer connections every 60 seconds
- ✅ Keeps the API running
- ✅ Shows status messages

## Troubleshooting

If peers can't connect:

1. Check if port 51820 is open:
   ```bash
   sudo ufw status
   ```

2. Verify WireGuard is running:
   ```bash
   docker exec wireguard wg show
   ```

3. Test the API:
   ```bash
   curl http://your-server:5000
   ```

4. Check firewall rules:
   ```bash
   docker exec wireguard iptables -L
   ```

