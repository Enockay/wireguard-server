#!/bin/bash
# Helper script to run WireGuard container with all required flags

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting WireGuard VPN Server...${NC}"

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found!${NC}"
    echo "Please create a .env file with your WIREGUARD_PRIVATE_KEY"
    exit 1
fi

# Check if image exists
if ! docker images | grep -q wireguard-vpn; then
    echo -e "${YELLOW}Building Docker image...${NC}"
    docker build -t wireguard-vpn .
fi

# Stop and remove existing container if it exists
if docker ps -a | grep -q wireguard; then
    echo -e "${YELLOW}Stopping existing container...${NC}"
    docker stop wireguard
    docker rm wireguard
fi

# Run the container with all required flags
echo -e "${GREEN}Starting container with privileged mode...${NC}"
docker run -d \
  --name wireguard \
  --privileged \
  --sysctl net.ipv4.ip_forward=1 \
  --sysctl net.ipv4.conf.all.forwarding=1 \
  --sysctl net.ipv6.conf.all.forwarding=1 \
  -p 51820:51820/udp \
  -p 5000:5000/tcp \
  --env-file .env \
  wireguard-vpn

# Wait a moment for startup
sleep 2

# Show logs
echo -e "${GREEN}Container started! Showing logs:${NC}"
docker logs wireguard

echo ""
echo -e "${GREEN}Container is running.${NC}"
echo "Check logs with: docker logs -f wireguard"
echo "API available at: http://localhost:5000"
echo "WireGuard listening on: UDP port 51820"

