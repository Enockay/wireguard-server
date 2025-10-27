@echo off
REM Helper script to run WireGuard container with all required flags on Windows

echo Starting WireGuard VPN Server...

REM Check if .env file exists
if not exist .env (
    echo Error: .env file not found!
    echo Please create a .env file with your WIREGUARD_PRIVATE_KEY
    exit /b 1
)

REM Check if image exists
docker images | findstr wireguard-vpn > nul
if errorlevel 1 (
    echo Building Docker image...
    docker build -t wireguard-vpn .
)

REM Stop and remove existing container if it exists
docker ps -a | findstr wireguard > nul
if not errorlevel 1 (
    echo Stopping existing container...
    docker stop wireguard
    docker rm wireguard
)

REM Run the container with all required flags
echo Starting container with privileged mode...
docker run -d `
  --name wireguard `
  --privileged `
  --sysctl net.ipv4.ip_forward=1 `
  --sysctl net.ipv4.conf.all.forwarding=1 `
  --sysctl net.ipv6.conf.all.forwarding=1 `
  -p 51820:51820/udp `
  -p 5000:5000/tcp `
  --env-file .env `
  wireguard-vpn

REM Wait a moment for startup
timeout /t 2 /nobreak > nul

REM Show logs
echo Container started! Showing logs:
docker logs wireguard

echo.
echo Container is running.
echo Check logs with: docker logs -f wireguard
echo API available at: http://localhost:5000
echo WireGuard listening on: UDP port 51820
pause

