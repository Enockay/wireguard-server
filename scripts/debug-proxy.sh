#!/bin/bash

# Debug script for TCP Proxy Service
# This script helps diagnose TCP proxy issues

echo "=== TCP Proxy Debugging Script ==="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in a container
if [ -f /.dockerenv ]; then
    echo -e "${YELLOW}Running inside Docker container${NC}"
    CONTAINER_IP=$(hostname -i)
else
    echo -e "${YELLOW}Running on host${NC}"
    CONTAINER_IP="localhost"
fi

echo ""
echo "=== 1. Checking Proxy Status via API ==="
API_URL="${API_URL:-http://localhost:5000}"
echo "API URL: $API_URL"

STATUS=$(curl -s "$API_URL/api/admin/proxy/status" 2>/dev/null)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ API is reachable${NC}"
    echo "$STATUS" | jq '.' 2>/dev/null || echo "$STATUS"
else
    echo -e "${RED}✗ Cannot reach API${NC}"
    echo "Make sure the API server is running on port 5000"
fi

echo ""
echo "=== 2. Checking Listening Ports ==="
echo "Checking for listening TCP ports in ranges:"
echo "  - Winbox: 1000-3333"
echo "  - SSH: 3334-6666"
echo "  - API: 6667-9999"

if command -v netstat &> /dev/null; then
    echo ""
    echo "Active TCP listeners (netstat):"
    netstat -tlnp 2>/dev/null | grep -E ':(100[0-9]|1[0-9]{3}|2[0-9]{3}|3[0-3][0-3][0-3]|666[7-9]|66[7-9][0-9]|6[7-9][0-9]{2}|[7-9][0-9]{3})' || echo "No matching ports found"
elif command -v ss &> /dev/null; then
    echo ""
    echo "Active TCP listeners (ss):"
    ss -tlnp 2>/dev/null | grep -E ':(100[0-9]|1[0-9]{3}|2[0-9]{3}|3[0-3][0-3][0-3]|666[7-9]|66[7-9][0-9]|6[7-9][0-9]{2}|[7-9][0-9]{3})' || echo "No matching ports found"
else
    echo -e "${YELLOW}Neither netstat nor ss available. Install one to check ports.${NC}"
fi

echo ""
echo "=== 3. Testing Specific Ports ==="
# Get ports from API if available
if [ ! -z "$STATUS" ]; then
    PORTS=$(echo "$STATUS" | jq -r '.detailedStatus[]?.ports | "\(.winbox) \(.ssh) \(.api)"' 2>/dev/null)
    if [ ! -z "$PORTS" ]; then
        echo "Testing ports from API response:"
        while IFS= read -r line; do
            if [ ! -z "$line" ]; then
                read -r winbox ssh api <<< "$line"
                echo ""
                echo "Router ports: Winbox=$winbox, SSH=$ssh, API=$api"
                
                for port in $winbox $ssh $api; do
                    if timeout 2 bash -c "echo > /dev/tcp/$CONTAINER_IP/$port" 2>/dev/null; then
                        echo -e "  Port $port: ${GREEN}✓ LISTENING${NC}"
                    else
                        echo -e "  Port $port: ${RED}✗ NOT LISTENING${NC}"
                    fi
                done
            fi
        done <<< "$PORTS"
    fi
fi

echo ""
echo "=== 4. Checking WireGuard Interface ==="
if command -v wg &> /dev/null; then
    if wg show wg0 &>/dev/null; then
        echo -e "${GREEN}✓ WireGuard interface wg0 exists${NC}"
        echo "Active peers:"
        wg show wg0 peers | wc -l | xargs echo "  Count:"
    else
        echo -e "${RED}✗ WireGuard interface wg0 not found${NC}"
    fi
else
    echo -e "${YELLOW}wg command not available${NC}"
fi

echo ""
echo "=== 5. Testing Router Connectivity ==="
# Get router VPN IPs from API
if [ ! -z "$STATUS" ]; then
    ROUTERS=$(echo "$STATUS" | jq -r '.detailedStatus[]? | "\(.routerId)|\(.vpnIp)|\(.routerName)"' 2>/dev/null)
    if [ ! -z "$ROUTERS" ]; then
        echo "Testing connectivity to router VPN IPs:"
        while IFS='|' read -r routerId vpnIp routerName; do
            if [ ! -z "$vpnIp" ] && [ "$vpnIp" != "null" ]; then
                echo ""
                echo "Router: $routerName ($routerId)"
                echo "  VPN IP: $vpnIp"
                
                # Test ping
                if ping -c 1 -W 2 "$vpnIp" &>/dev/null; then
                    echo -e "  Ping: ${GREEN}✓ REACHABLE${NC}"
                else
                    echo -e "  Ping: ${RED}✗ NOT REACHABLE${NC}"
                fi
                
                # Test MikroTik ports
                for port in 8291 22 8728; do
                    if timeout 2 bash -c "echo > /dev/tcp/$vpnIp/$port" 2>/dev/null; then
                        echo -e "  Port $port: ${GREEN}✓ OPEN${NC}"
                    else
                        echo -e "  Port $port: ${RED}✗ CLOSED${NC}"
                    fi
                done
            fi
        done <<< "$ROUTERS"
    fi
fi

echo ""
echo "=== 6. Docker Container Info ==="
if [ -f /.dockerenv ]; then
    echo "Container hostname: $(hostname)"
    echo "Container IP: $(hostname -i)"
    echo "Network mode: Check docker-compose.yml"
    echo ""
    echo -e "${YELLOW}Note: If using network_mode: service:wireguard, ports are exposed via the WireGuard container${NC}"
fi

echo ""
echo "=== Debugging Complete ==="
echo ""
echo "Common Issues:"
echo "1. Ports not exposed in Docker/Coolify - Check docker-compose.yml and Coolify port settings"
echo "2. Router not connected to VPN - Check WireGuard peer status"
echo "3. Firewall blocking - Check iptables/ufw rules"
echo "4. Proxy not listening - Check API logs for errors"
echo ""
echo "Next Steps:"
echo "- Check API logs: docker logs wireguard-api"
echo "- Test proxy connection: curl -X POST $API_URL/api/admin/proxy/test -H 'Content-Type: application/json' -d '{\"routerId\":\"...\",\"portType\":\"winbox\"}'"
echo "- Check Coolify port configuration"
