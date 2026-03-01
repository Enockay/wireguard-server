# Router Status Monitoring

## Overview

The system now determines router activity by **actively connecting to MikroTik routers** via their VPN IP and retrieving routerboard information (uptime, resources, etc.), rather than just checking WireGuard peer status.

## How It Works

### Active Status Check

A router is considered **active** when:

1. The system can successfully connect to the router via its VPN IP
2. The system can retrieve routerboard information (uptime, CPU load, memory, etc.)
3. The router responds to API/SSH connections

### Monitoring Process

1. **Every 5 minutes**, the system checks all routers with status `pending`, `active`, or `offline`
2. For each router:
   - Connects to the router's VPN IP (e.g., `10.0.0.23`)
   - Attempts to retrieve routerboard information via SSH
   - If SSH fails, falls back to checking if API port (8728) is open
   - Updates router status based on connection success
   - Stores routerboard information in the database

### Routerboard Information Retrieved

When a router is active, the system retrieves and stores:

- **Uptime**: How long the router has been running
- **CPU Load**: Current CPU usage
- **Memory Usage**: Used memory
- **Total Memory**: Total available memory
- **Free Memory**: Available free memory
- **Board Name**: Routerboard model name
- **Model**: Router model
- **Serial Number**: Device serial number
- **Firmware**: Current firmware version

## Implementation Details

### MikroTik API Service

Located in: `services/mikrotik-api-service.js`

**Main Functions:**

- `checkRouterActive(vpnIp, options)`: Checks if router is active
- `getRouterboardInfo(vpnIp, options)`: Retrieves routerboard information
- `executeRouterOSCommand(vpnIp, command, username, password)`: Executes RouterOS commands via SSH

### Connection Methods

1. **SSH (Primary)**: 
   - Connects via SSH to execute RouterOS commands
   - Retrieves detailed routerboard information
   - Commands used:
     - `/system resource print` - Get system resources
     - `/system routerboard print` - Get routerboard info

2. **API Port Check (Fallback)**:
   - Checks if MikroTik API port (8728) is open
   - Used when SSH is not available or fails
   - Less detailed but more reliable

### Database Schema

The `MikrotikRouter` model now includes a `routerboardInfo` field:

```javascript
routerboardInfo: {
    uptime: String,
    cpuLoad: String,
    memoryUsage: String,
    totalMemory: String,
    freeMemory: String,
    boardName: String,
    model: String,
    serialNumber: String,
    firmware: String,
    lastChecked: Date
}
```

## API Endpoints

### Get Router Details

**Endpoint**: `GET /api/routers/:id`

**Response includes routerboard info:**

```json
{
  "success": true,
  "router": {
    "id": "...",
    "name": "My Router",
    "status": "active",
    "routerboardInfo": {
      "uptime": "5d 3h 2m 15s",
      "cpuLoad": "5%",
      "memoryUsage": "45MB",
      "totalMemory": "256MB",
      "freeMemory": "211MB",
      "boardName": "RB750",
      "model": "hEX",
      "serialNumber": "ABC123",
      "firmware": "7.12",
      "lastChecked": "2026-03-01T06:00:00.000Z"
    },
    ...
  }
}
```

### List Routers

**Endpoint**: `GET /api/routers`

**Response includes routerboard info for each router:**

```json
{
  "success": true,
  "routers": [
    {
      "id": "...",
      "name": "My Router",
      "status": "active",
      "isOnline": true,
      "routerboardInfo": {
        "uptime": "5d 3h 2m 15s",
        "cpuLoad": "5%",
        ...
      },
      ...
    }
  ]
}
```

## Configuration

### SSH Authentication

The system uses SSH to connect to routers. You can configure:

- **Username**: Default is `admin` (can be made configurable)
- **Password**: Empty by default (use SSH keys in production)
- **SSH Keys**: Recommended for production use

### Environment Variables

Currently, authentication is hardcoded. To make it configurable:

```javascript
const username = process.env.MIKROTIK_SSH_USERNAME || 'admin';
const password = process.env.MIKROTIK_SSH_PASSWORD || '';
```

### SSH Requirements

The system requires:
- `ssh` command-line tool (usually pre-installed)
- `sshpass` (if using password authentication)
- SSH access to routers via VPN IP

## Monitoring Interval

- **Check Interval**: Every 5 minutes
- **Timeout**: 5 seconds per router
- **Delay Between Checks**: 500ms to avoid overwhelming the system

## Logging

The system logs:

- `router_status_check_started`: When monitoring cycle starts
- `router_status_check_success`: When router is successfully checked and active
- `router_status_check_failed`: When router check fails
- `router_status_check_error`: When there's an error checking a router
- `router_status_check_completed`: When monitoring cycle completes

## Benefits

1. **More Accurate Status**: Determines activity by actually accessing the router, not just VPN connection
2. **Rich Information**: Retrieves and stores routerboard details (uptime, resources, etc.)
3. **Better Monitoring**: Can detect if router is connected but not responding
4. **User Visibility**: Users can see router uptime and resource usage in the dashboard

## Troubleshooting

### Router Not Showing as Active

1. **Check VPN Connection**: Ensure router is connected to WireGuard VPN
2. **Check SSH Access**: Verify SSH is enabled on the router
3. **Check Firewall**: Ensure router firewall allows SSH from VPN IP range
4. **Check Logs**: Review logs for `router_status_check_failed` messages

### SSH Connection Fails

1. **Verify SSH is Enabled**: Check router configuration
2. **Check Credentials**: Ensure username/password are correct
3. **Check SSH Keys**: If using key-based auth, ensure keys are configured
4. **Check Network**: Verify router is reachable via VPN IP

### API Port Check Fails

1. **Verify API is Enabled**: Check router configuration
2. **Check Firewall**: Ensure API port (8728) is not blocked
3. **Check Router Status**: Router may be offline or unreachable

## Future Enhancements

- [ ] Configurable SSH credentials per router
- [ ] Support for RouterOS REST API (RouterOS 7+)
- [ ] More detailed resource monitoring
- [ ] Historical resource data tracking
- [ ] Alerts for high CPU/memory usage
- [ ] Automatic SSH key management
