# SSH Setup for MikroTik Router Status Monitoring

## Issue

The router status monitoring system requires SSH access to MikroTik routers to retrieve routerboard information. The error `ssh: not found` indicates that the SSH client is not installed in the Docker container.

## Solution

### 1. Updated Dockerfile.api

The `Dockerfile.api` has been updated to install `openssh-client`:

```dockerfile
RUN apk update && \
    apk add --no-cache \
        nodejs \
        npm \
        wireguard-tools \
        curl \
        openssh-client && \
    # Try to install sshpass from edge/testing if available, otherwise skip
    (apk add --no-cache sshpass 2>/dev/null || echo "sshpass not available, password auth disabled") || true
```

### 2. Rebuild the Container

After updating the Dockerfile, rebuild the API container:

```bash
docker-compose build wireguard-api
docker-compose up -d wireguard-api
```

Or if using Coolify, push the changes and redeploy.

## SSH Authentication

The system supports two authentication methods:

### Method 1: SSH Key-Based Authentication (Recommended)

1. **Generate SSH Key Pair** (if not already done):
   ```bash
   ssh-keygen -t rsa -b 4096 -f /path/to/mikrotik_key -N ""
   ```

2. **Copy Public Key to MikroTik Router**:
   - Via Winbox: System → Users → SSH Keys → Import
   - Via SSH: Copy the public key content and add it to the router

3. **Add Private Key to Docker Container**:
   - Mount the private key as a volume in `docker-compose.yml`:
     ```yaml
     volumes:
       - /path/to/mikrotik_key:/root/.ssh/mikrotik_key:ro
     ```
   - Or copy it into the container during build

4. **Configure SSH to Use the Key**:
   - The service will automatically use `~/.ssh/id_rsa` or you can configure a specific key

### Method 2: Password Authentication

If using password authentication, you need `sshpass` installed:

```bash
# In Dockerfile.api, add:
apk add --no-cache sshpass
```

Then set the password in environment variables or configuration.

**Note**: Password authentication is less secure and not recommended for production.

## Fallback Behavior

If SSH is not available or authentication fails, the system automatically falls back to:

1. **API Port Check**: Checks if MikroTik API port (8728) is open
2. **Basic Connectivity**: Marks router as reachable if API port responds

This ensures the system continues to work even if SSH is not configured, though with less detailed information.

## Testing SSH Access

To test SSH access from the container:

```bash
# Enter the container
docker exec -it wireguard-api sh

# Test SSH connection
ssh -o StrictHostKeyChecking=no admin@10.0.0.23 "/system resource print"
```

## Troubleshooting

### Error: "ssh: not found"

**Solution**: Rebuild the container with the updated Dockerfile that includes `openssh-client`.

### Error: "Permission denied (publickey)"

**Solution**: 
1. Set up SSH key-based authentication
2. Or configure password authentication with `sshpass`
3. Or the system will fall back to API port check

### Error: "sshpass: not found"

**Solution**: 
- This is optional - only needed for password authentication
- The system will work without it using key-based auth or API port check
- To install: `apk add --no-cache sshpass` (may require edge/testing repo)

### Router Status Shows "Offline" but Router is Connected

**Possible Causes**:
1. SSH is not configured on the router
2. Firewall blocking SSH from VPN IP range
3. SSH authentication failing

**Solution**:
1. Enable SSH on the router: `/ip service enable ssh`
2. Check firewall rules
3. Verify SSH authentication
4. System will fall back to API port check if SSH fails

## Current Status

- ✅ SSH client installation added to Dockerfile
- ✅ Graceful fallback to API port check
- ✅ Error handling for missing SSH
- ⚠️ SSH authentication needs to be configured per deployment
- ⚠️ sshpass installation may require additional repository configuration

## Next Steps

1. **Rebuild the container** with the updated Dockerfile
2. **Configure SSH authentication** (keys or password)
3. **Test SSH access** from the container
4. **Monitor logs** to verify router status checks are working

The system will automatically use SSH if available, or fall back to API port check if not.
