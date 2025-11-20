# How to Generate a New MikroTik Client

There are **two easy ways** to generate a MikroTik RouterOS configuration:

## Method 1: Quick Method (Recommended) ⚡

Use the short URL endpoint - it automatically creates the client if it doesn't exist:

### For Linux/Mac/Git Bash:

```bash
# Replace YOUR_SERVER with your Coolify URL or IP
# Replace "mikrotik" with your desired client name

curl -sS "http://YOUR_SERVER:5000/mt/mikrotik" -o mikrotik.rsc
```

**Example:**
```bash
# If your server is at http://ycc84gwwgk0o484wssgcoscg.157.245.40.199.sslip.io
curl -sS "http://ycc84gwwgk0o484wssgcoscg.157.245.40.199.sslip.io:5000/mt/mikrotik" -o mikrotik.rsc
```

### For Windows PowerShell:

```powershell
# Simple GET request - easiest method!
Invoke-WebRequest -Uri "http://157.245.40.199:5000/mt/mikrotik" -OutFile "mikrotik.rsc"

# Or using curl.exe explicitly
curl.exe -sS "http://157.245.40.199:5000/mt/mikrotik" -o mikrotik.rsc
```

**Optional query parameters:**
```bash
# With custom interface name
curl -sS "http://YOUR_SERVER:5000/mt/mikrotik?iface=wg-office" -o mikrotik.rsc

# With custom subnet
curl -sS "http://YOUR_SERVER:5000/mt/mikrotik?subnet=10.0.0.0/24" -o mikrotik.rsc

# With notes
curl -sS "http://YOUR_SERVER:5000/mt/mikrotik?notes=Office%20Router" -o mikrotik.rsc
```

## Method 2: Full Method (More Options)

### For Linux/Mac/Git Bash:

```bash
curl -X POST http://YOUR_SERVER:5000/generate-mikrotik \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mikrotik",
    "notes": "Office Router",
    "interfaceName": "wireguard-mikrotik",
    "allowedSubnet": "10.0.0.0/24"
  }' \
  -o mikrotik.rsc
```

### For Windows PowerShell:

**Option A: Use Invoke-RestMethod (Recommended)**
```powershell
$body = @{
    name = "mikrotik"
    notes = "Enock Mikrotik"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://157.245.40.199:5000/generate-mikrotik" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body `
    -OutFile "mikrotik.rsc"
```

**Option B: Use curl.exe explicitly**
```powershell
curl.exe -X POST http://157.245.40.199:5000/generate-mikrotik `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"mikrotik\",\"notes\":\"Enock Mikrotik\"}' `
  -o mikrotik.rsc
```

**Option C: One-liner with Invoke-WebRequest**
```powershell
Invoke-WebRequest -Uri "http://157.245.40.199:5000/generate-mikrotik" -Method POST -ContentType "application/json" -Body '{"name":"mikrotik","notes":"Enock Mikrotik"}' -OutFile "mikrotik.rsc"
```

## How to Use the Generated Script

1. **Download the script** using one of the methods above
2. **Open MikroTik RouterOS** (Winbox or WebFig)
3. **Go to:** System → Scripts
4. **Paste the script** into a new script or run it directly in Terminal
5. **Run the script** - it will:
   - Create the WireGuard interface
   - Set up the keys and IP address
   - Add the peer (server)
   - Configure routing
   - Test connectivity automatically

## Verify It Works

After running the script, check:

```bash
# In MikroTik Terminal:
/interface wireguard print
/ip address print where interface~"wireguard"
/ping 10.0.0.1 count=5
```

You should see:
- ✅ WireGuard interface created
- ✅ IP address assigned (e.g., 10.0.0.7/32)
- ✅ Ping to server (10.0.0.1) succeeds

## List All Clients

To see all generated clients:

```bash
curl http://YOUR_SERVER:5000/clients
```

## Get Existing Client Config

If you already created a client and want to get its config again:

```bash
# For MikroTik script
curl -sS "http://YOUR_SERVER:5000/mt/mikrotik" -o mikrotik.rsc

# For regular WireGuard config (.conf file)
curl -sS "http://YOUR_SERVER:5000/clients/mikrotik" -o mikrotik.conf
```

## Troubleshooting

### Error: "Client with this name already exists"
- The client name is already taken
- Use a different name, or delete the existing client first:
  ```bash
  curl -X DELETE http://YOUR_SERVER:5000/clients/mikrotik
  ```

### Script doesn't work in MikroTik
- Make sure you're using RouterOS v7.0+ (WireGuard support)
- Check that the script was downloaded completely (not truncated)
- Try running it section by section in Terminal

### Can't connect to server
- Verify server endpoint is correct (check `SERVER_ENDPOINT` environment variable)
- Check firewall rules on both server and MikroTik
- Ensure port 51820/UDP is open

## Example: Generate Multiple MikroTik Clients

```bash
# Office router
curl -sS "http://YOUR_SERVER:5000/mt/office-router" -o office.rsc

# Home router  
curl -sS "http://YOUR_SERVER:5000/mt/home-router" -o home.rsc

# Branch office
curl -sS "http://YOUR_SERVER:5000/mt/branch-office" -o branch.rsc
```

Each will get a unique IP address automatically (10.0.0.6, 10.0.0.7, 10.0.0.8, etc.)

