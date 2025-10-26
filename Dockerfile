# Use Alpine as the base image
FROM alpine:latest

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

# Copy the API script
COPY wireguard-api.js /app/

# Install API dependencies
RUN npm init -y && npm install express body-parser child_process cors

# Expose ports (UDP for WireGuard, TCP for API)
EXPOSE 51820/udp
EXPOSE 5000/tcp

# Set entrypoint to run.sh
ENTRYPOINT ["/run.sh"]
