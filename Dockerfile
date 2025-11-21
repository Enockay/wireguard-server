# Use Alpine as the base image
FROM alpine:latest

# IMPORTANT: This container MUST be run with --privileged flag for WireGuard to work
# Example: docker run --privileged --env-file .env wireguard-vpn
# Or use docker-compose.yml which has privileged: true configured

# Update package list and install necessary tools, including WireGuard, iptables, and Node.js
RUN apk update && \
    apk add --no-cache \
        wireguard-tools \
        iproute2 \
        bash \
        curl \
        nano \
        iptables \
        nodejs \
        npm

# Copy WireGuard configuration and scripts
COPY wg0.conf /etc/wireguard/wg0.conf
COPY run.sh /run.sh

# Make sure the script is executable
RUN chmod +x /run.sh

# Set working directory for API
WORKDIR /app

# Copy the API script and database files
COPY wireguard-api.js /app/
COPY db.js /app/
COPY models /app/models/

# Install API dependencies including mongoose for MongoDB
# Note: child_process is a built-in Node.js module, no need to install it
RUN npm init -y && npm install --no-audit --no-fund express body-parser cors mongoose

# Expose ports (UDP for WireGuard, TCP for API)
EXPOSE 51820/udp
EXPOSE 5000/tcp

# Set entrypoint to run.sh
ENTRYPOINT ["/run.sh"]

# Required runtime capabilities for this container:
# --privileged: Required for WireGuard to create network interfaces
# --env-file .env: To load WIREGUARD_PRIVATE_KEY
# -p 51820:51820/udp: WireGuard port
# -p 5000:5000/tcp: API port
