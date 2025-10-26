#!/bin/bash

set -ex

# Apply sysctl settings for IP forwarding
cat << EOF > /etc/sysctl.d/forward.conf
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv6.conf.all.forwarding = 1
EOF

sysctl -p /etc/sysctl.d/forward.conf

# Replace placeholder in the template with the secret
sed -i "s/{{WIREGUARD_PRIVATE_KEY}}/$WIREGUARD_PRIVATE_KEY/" /etc/wireguard/wg0.conf

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
