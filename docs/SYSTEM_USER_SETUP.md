# System User for SSH Monitoring

## Overview

The autoconfig script now automatically creates a dedicated system user on each MikroTik router for SSH-based monitoring. This user is used by the system to retrieve routerboard information (uptime, CPU, memory, etc.) to determine router status.

## How It Works

### 1. User Creation

When a router runs the autoconfig script, it automatically:

1. **Creates a system user** (default: `wgmonitor`)
2. **Sets a secure password** (from environment variable or auto-generated)
3. **Configures user permissions** (read-only access)
4. **Restricts access** to VPN network (10.0.0.0/24)
5. **Enables SSH service** on the router
6. **Adds firewall rule** to allow SSH from VPN network

### 2. User Configuration

The system user is created with:
- **Username**: `wgmonitor` (configurable via `MIKROTIK_SYSTEM_USERNAME`)
- **Group**: `read` (read-only access)
- **Address restriction**: `10.0.0.0/24` (only accessible from VPN network)
- **Password**: Set via `MIKROTIK_SYSTEM_PASSWORD` or auto-generated

### 3. SSH Access

The system uses this user to:
- Connect via SSH to retrieve routerboard information
- Execute RouterOS commands: `/system resource print` and `/system routerboard print`
- Monitor router status and health

## Configuration

### Environment Variables

Add these to your `.env` file or Coolify environment variables:

```bash
# System user username (default: wgmonitor)
MIKROTIK_SYSTEM_USERNAME=wgmonitor

# System user password (REQUIRED - set a strong password!)
MIKROTIK_SYSTEM_PASSWORD=YourSecurePassword123!@#
```

### Important Notes

1. **Password Security**: 
   - If `MIKROTIK_SYSTEM_PASSWORD` is not set, a random password will be generated
   - The generated password will be logged (check logs for it)
   - **Recommended**: Set a fixed password in environment variables for consistency

2. **Password Consistency**:
   - All routers will use the same password (from environment variable)
   - This ensures the monitoring system can access all routers
   - If password is auto-generated, each router will have a different password (not recommended)

3. **User Permissions**:
   - User is created with `read` group (read-only access)
   - Can execute monitoring commands but cannot modify router configuration
   - Access is restricted to VPN network (10.0.0.0/24)

## Autoconfig Script Changes

The autoconfig script now includes:

```routeros
# Create system user for SSH monitoring (if not exists)
:if ([/user/print count-only where name=$SYSUSER] = 0) do={
    /user/add name=$SYSUSER password=$SYSPASS group=read address=10.0.0.0/24
    :put "System user $SYSUSER created for monitoring"
} else={
    /user/set $SYSUSER password=$SYSPASS
    :put "System user $SYSUSER password updated"
}

# Enable SSH service if not enabled
/ip/service/enable ssh

# Ensure SSH is allowed from VPN network
:if ([/ip/firewall/filter/print count-only where chain=input protocol=tcp dst-port=22 src-address=10.0.0.0/24 comment~"Allow SSH from VPN network"] = 0) do={
    /ip/firewall/filter/add chain=input protocol=tcp dst-port=22 src-address=10.0.0.0/24 action=accept place-before=0 comment="Allow SSH from VPN network" disabled=no
}
```

## Security Considerations

### 1. Password Management

- **Set a strong password** in environment variables
- **Never commit** passwords to version control
- **Rotate passwords** periodically if needed
- **Use environment variables** in production (not hardcoded)

### 2. Network Restrictions

- User access is restricted to VPN network (10.0.0.0/24)
- SSH is only allowed from VPN IPs
- Firewall rules ensure only VPN network can access SSH

### 3. User Permissions

- User has `read` group permissions (read-only)
- Cannot modify router configuration
- Can only execute monitoring commands

## Troubleshooting

### User Not Created

**Symptoms**: Router status shows offline, SSH connection fails

**Solution**:
1. Check if autoconfig script ran successfully
2. Verify user exists: `/user/print where name=wgmonitor`
3. Re-run autoconfig script if needed

### SSH Connection Fails

**Symptoms**: `Permission denied` or `Authentication failed`

**Solution**:
1. Verify password is correct in environment variables
2. Check user exists on router: `/user/print where name=wgmonitor`
3. Verify SSH is enabled: `/ip/service/print where name=ssh`
4. Check firewall rules allow SSH from VPN network

### Password Mismatch

**Symptoms**: Different routers have different passwords

**Solution**:
1. Set `MIKROTIK_SYSTEM_PASSWORD` in environment variables
2. Re-run autoconfig script on all routers
3. Or manually update password on each router

## Manual User Creation

If you need to manually create the user on a router:

```routeros
# Create user
/user/add name=wgmonitor password=YourSecurePassword123!@# group=read address=10.0.0.0/24

# Enable SSH
/ip/service/enable ssh

# Allow SSH from VPN network
/ip/firewall/filter/add chain=input protocol=tcp dst-port=22 src-address=10.0.0.0/24 action=accept comment="Allow SSH from VPN network"
```

## Testing

To test SSH access from the API container:

```bash
# Enter the container
docker exec -it wireguard-api sh

# Test SSH connection
ssh -o StrictHostKeyChecking=no wgmonitor@10.0.0.23 "/system resource print"
```

You should be prompted for the password (or it should work if using key-based auth).

## Next Steps

1. **Set environment variables** in `.env` or Coolify:
   ```bash
   MIKROTIK_SYSTEM_USERNAME=wgmonitor
   MIKROTIK_SYSTEM_PASSWORD=YourSecurePassword123!@#
   ```

2. **Redeploy the API container** to pick up the new environment variables

3. **Re-run autoconfig** on existing routers (or wait for new routers to be created)

4. **Verify** router status monitoring is working (check logs)

The system will now automatically create the user on each router and use it for SSH-based monitoring!
