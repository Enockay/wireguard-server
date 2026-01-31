#!/bin/bash

set -e

echo "Starting WireGuard Management API..."

# Wait a moment for WireGuard container to be ready
sleep 2

# Check if WireGuard interface is accessible (we're sharing network namespace)
if wg show wg0 &>/dev/null; then
    echo "✅ WireGuard interface is accessible"
else
    echo "⚠️  Warning: WireGuard interface not yet accessible (may start later)"
fi

# Start the Express API
echo "Starting API server on port 5000..."
exec node /app/wireguard-api.js
