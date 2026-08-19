#!/bin/bash

set -ex

# Check if WIREGUARD_PRIVATE_KEY is set
if [ -z "$WIREGUARD_PRIVATE_KEY" ]; then
    echo "Error: WIREGUARD_PRIVATE_KEY environment variable is not set"
    exit 1
fi

# Apply sysctl settings for IP forwarding
# Note: These may fail in non-privileged containers - that's ok, Docker handles IP forwarding
echo "Attempting to configure IP forwarding..."
if cat << EOF > /etc/sysctl.d/forward.conf
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv6.conf.all.forwarding = 1
EOF
then
    sysctl -p /etc/sysctl.d/forward.conf 2>/dev/null || echo "IP forwarding will be handled by Docker"
else
    echo "Warning: Could not write to /etc/sysctl.d/forward.conf"
fi

# Replace placeholders in the template with values from environment variables.
# Use @ as delimiter to avoid conflicts with / or special characters in the key.
sed -i "s@{{WIREGUARD_PRIVATE_KEY}}@$WIREGUARD_PRIVATE_KEY@" /etc/wireguard/wg0.conf

# VPN subnet for this deployment (lets a separate deployment - e.g. a test
# environment - run its own non-overlapping VPN network instead of colliding
# with another deployment's 10.0.0.0/24, and reusing the same peer's public
# key across two deployments with overlapping subnets, both of which cause
# silent routing/reply failures on client routers that hold tunnels to both).
WG_SERVER_ADDRESS="${WG_SERVER_ADDRESS:-10.0.0.1/24}"
sed -i "s@{{WG_SERVER_ADDRESS}}@$WG_SERVER_ADDRESS@" /etc/wireguard/wg0.conf

echo "WireGuard private key has been set from environment variable"
echo "WireGuard interface address set to $WG_SERVER_ADDRESS"

# Start WireGuard interface.
# Retry with backoff: on first boot the host may apply --privileged /
# NET_ADMIN+SYS_MODULE capabilities or mount /lib/modules a beat after the
# entrypoint starts, so a single failed attempt here isn't necessarily fatal.
echo "Starting WireGuard interface..."
wg_up_attempts=5
wg_up_delay=5
wg_up_ok=0
for attempt in $(seq 1 "$wg_up_attempts"); do
    if wg-quick up wg0 2>&1; then
        echo "✅ WireGuard interface started successfully (attempt $attempt/$wg_up_attempts)"
        wg_up_ok=1
        break
    fi
    echo "⚠️  Attempt $attempt/$wg_up_attempts to start WireGuard interface failed"
    wg-quick down wg0 2>/dev/null || true
    if [ "$attempt" -lt "$wg_up_attempts" ]; then
        echo "Retrying in ${wg_up_delay}s..."
        sleep "$wg_up_delay"
    fi
done

if [ "$wg_up_ok" -ne 1 ]; then
    echo "❌ WARNING: Failed to start WireGuard interface after $wg_up_attempts attempts"
    echo "This may require:"
    echo "  1. Running container with --privileged flag"
    echo "  2. Or wireguard kernel module loaded on host (modprobe wireguard)"
    echo "  3. Or network mode capabilities"
    exit 1
fi

# Keep container running and monitor WireGuard status
echo "WireGuard VPN server is now running on port 51820"
echo "Status will be checked periodically"

fail_count=0
while true; do
    sleep 60
    if wg show wg0 &>/dev/null; then
        fail_count=0
        if ! wg show wg0 | grep -q "peer"; then
            echo "⚠️  WireGuard interface is up but no peers connected"
        fi
    else
        fail_count=$((fail_count + 1))
        echo "⚠️  WireGuard check failed ($fail_count/3)"
        if [ $fail_count -ge 3 ]; then
            echo "⚠️  WireGuard interface is down - attempting restart..."
            wg-quick down wg0 2>/dev/null || true
            if wg-quick up wg0 2>/dev/null; then
                echo "✅ WireGuard interface restarted successfully"
                # Signal API to reload all peers from database
                sleep 2
                curl -s -X POST http://localhost:5020/reload || echo "API reload failed"
            else
                echo "❌ Failed to restart WireGuard interface - will retry later"
            fi
            fail_count=0
        fi
    fi
done
