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
wg-quick up wg0

# Start the Express API in the background
node /app/wireguard-api.js &

# Monitor and ensure WireGuard stays active
while true; do
    if ! wg show | grep -q "peer"; then
        echo "WireGuard interface down. Restarting..."
        wg-quick down wg0
        wg-quick up wg0
    fi
    sleep 60
done
