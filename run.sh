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

# Replace placeholder in the template with the secret from environment variable
# Use @ as delimiter to avoid conflicts with / or special characters in the key
sed -i "s@{{WIREGUARD_PRIVATE_KEY}}@$WIREGUARD_PRIVATE_KEY@" /etc/wireguard/wg0.conf

echo "WireGuard private key has been set from environment variable"

# Start WireGuard interface
echo "Starting WireGuard interface..."
if wg-quick up wg0; then
    echo "WireGuard interface started successfully"
else
    echo "Error: Failed to start WireGuard interface"
    echo "This may require:"
    echo "  1. Running container with --privileged flag"
    echo "  2. Or wireguard kernel module loaded on host (modprobe wireguard)"
    echo "  3. Or network mode capabilities"
    echo "Exiting..."
    exit 1
fi

# Start the Express API in the background
echo "Starting WireGuard API..."
node /app/wireguard-api.js &

# Keep container running and monitor WireGuard status
while true; do
    if wg show wg0 &>/dev/null; then
        if ! wg show wg0 | grep -q "peer"; then
            echo "Warning: WireGuard interface is up but no peers connected"
        fi
    else
        echo "Error: WireGuard interface is down!"
        wg-quick down wg0 || true
        if wg-quick up wg0; then
            echo "WireGuard interface restarted successfully"
        else
            echo "Failed to restart WireGuard interface"
        fi
    fi
    sleep 60
done
