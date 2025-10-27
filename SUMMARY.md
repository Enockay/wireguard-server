# MongoDB Integration Summary

## What Was Added

Your WireGuard API now uses **MongoDB** for professional client management!

### New Files Created

1. **`models/Client.js`** - Mongoose model for client schema
2. **`db.js`** - MongoDB connection handler
3. **`MONGODB_USAGE.md`** - Complete documentation

### Files Modified

1. **`wireguard-api.js`** - Added MongoDB integration and new endpoints
2. **`Dockerfile`** - Added mongoose and MongoDB files
3. **`docker-compose.yml`** - Added MongoDB service
4. **`README.md`** - Updated with MongoDB features

## Key Features

✅ **Named Clients** - Each client must have a unique name (required)  
✅ **Enable/Disable** - Admin can remotely enable or disable clients  
✅ **Auto-Recovery** - Clients automatically reload on server startup  
✅ **Persistent Storage** - Client data survives server restarts  
✅ **Notes Field** - Add notes/description for each client  
✅ **Professional Schema** - Mongoose model with validation  

## Database Schema

```javascript
{
  name: "john-laptop"        // Required, unique, lowercase
  ip: "10.0.0.8/32"          // Required, unique
  publicKey: "..."           // Required, unique
  privateKey: "..."          // Required
  enabled: true              // Boolean, default true
  notes: "Personal laptop"   // Optional
  createdAt: Date            // Auto-generated
  updatedAt: Date            // Auto-generated
}
```

## New API Endpoints

### Generate Client (Now requires name!)
```bash
curl -X POST http://YOUR_SERVER:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "john-laptop", "notes": "Personal laptop"}'
```

### List All Clients
```bash
curl http://YOUR_SERVER:5000/clients
```

### Get Client Config
```bash
curl http://YOUR_SERVER:5000/clients/john-laptop -o john.conf
```

### Enable/Disable Client
```bash
# Disable
curl -X PATCH http://YOUR_SERVER:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Enable
curl -X PATCH http://YOUR_SERVER:5000/clients/john-laptop \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Delete Client
```bash
curl -X DELETE http://YOUR_SERVER:5000/clients/john-laptop
```

## How It Works

### On Server Startup

1. WireGuard interface starts
2. API starts in background
3. **Connects to MongoDB**
4. **Loads all enabled clients from database**
5. **Applies them to WireGuard automatically**
6. Clients can connect immediately!

### When Creating a Client

1. Generate keys
2. Assign next available IP
3. **Save to MongoDB (with name)**
4. Add to WireGuard
5. Return config file

### When Enabling/Disabling

- **Enable:** Add peer to WireGuard from database
- **Disable:** Remove peer from WireGuard (but keep in database)

## Deployment

### Update Your Deployment

Your `docker-compose.yml` now includes MongoDB:

```bash
# Rebuild and restart
docker-compose down
docker-compose build
docker-compose up -d
```

This will start:
- **WireGuard container** (ports 51820 UDP, 5000 TCP)
- **MongoDB container** (port 27017)
- Both connected in same network

### Environment Variables

Add to your `.env` file:

```bash
# Existing
WIREGUARD_PRIVATE_KEY=AHda7jGcuWpO5mtz7KunI1qz5o3xqc0PsBigRpb7/kg=
SERVER_ENDPOINT=135.237.154.32:51820

# MongoDB (optional - defaults shown)
MONGO_URI=mongodb://mongo:27017/wireguard
```

### Using External MongoDB

If you have an external MongoDB server:

```bash
# In .env file
MONGO_URI=mongodb://your-mongo-host:27017/wireguard
```

## Benefits Over Previous System

| Feature | Old System | New MongoDB System |
|---------|-----------|-------------------|
| **Persistence** | ❌ Lost on restart | ✅ Survives restarts |
| **Client Names** | ❌ Not tracked | ✅ Required, indexed |
| **Enable/Disable** | ❌ Delete only | ✅ Enable/disable |
| **Admin Control** | ❌ Limited | ✅ Full control |
| **Notes** | ❌ None | ✅ Add notes |
| **Scalability** | ⚠️ Limited | ✅ Hundreds of clients |
| **Database** | ❌ No database | ✅ MongoDB |

## Quick Start

### 1. Start the System

```bash
docker-compose up -d
```

### 2. Create Your First Client

```bash
curl -X POST http://YOUR_SERVER:5000/generate-client \
  -H "Content-Type: application/json" \
  -d '{"name": "my-first-client"}' > my-client.conf
```

### 3. List All Clients

```bash
curl http://YOUR_SERVER:5000/clients
```

### 4. Disable a Client

```bash
curl -X PATCH http://YOUR_SERVER:5000/clients/my-first-client \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### 5. Re-download Config

```bash
curl http://YOUR_SERVER:5000/clients/my-first-client -o my-client.conf
```

## Troubleshooting

### Database Not Connecting?

Check logs:
```bash
docker logs wireguard
```

Expected messages:
- `🔄 Connecting to MongoDB...`
- `✅ MongoDB connected successfully`
- `✅ Database initialized, loading clients...`

### Clients Not Loading?

Check database status:
```bash
curl http://YOUR_SERVER:5000/
```

Look for: `"database": "connected"`

### Manual Reload

```bash
curl -X POST http://YOUR_SERVER:5000/reload
```

## Next Steps

1. **Read** [MONGODB_USAGE.md](MONGODB_USAGE.md) for detailed API docs
2. **Create** your first client with a name
3. **Test** enable/disable functionality
4. **Enjoy** persistent client management!

