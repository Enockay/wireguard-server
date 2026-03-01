# Multi-Tenant MikroTik Router Management System

## Overview

This system provides a complete multi-tenant solution for managing MikroTik routers with:
- User authentication and email verification
- Router creation and management
- Dynamic port allocation
- Monthly billing per router
- 1-week free trial for new accounts
- Email notifications

## Architecture

### Models

1. **User** (`models/User.js`)
   - Email/password authentication
   - Email verification
   - 1-week free trial tracking
   - Role-based access (user/admin)

2. **MikrotikRouter** (`models/MikrotikRouter.js`)
   - Links to User and WireGuard Client
   - Port allocation (Winbox, SSH, API)
   - Status tracking (pending/active/inactive/offline)

3. **Subscription** (`models/Subscription.js`)
   - Monthly billing per router
   - Trial period management
   - Payment tracking

### Services

1. **Email Service** (`services/email-service.js`)
   - Uses Brevo API for sending emails
   - Email verification
   - Router created notification
   - Router online notification

2. **Billing Service** (`services/billing-service.js`)
   - Subscription creation
   - Monthly billing processing
   - Trial to paid transition
   - Billing summary

3. **Port Allocator** (`utils/port-allocator.js`)
   - Dynamic port allocation
   - Port range management
   - Port release on router deletion

### Routes

1. **Auth Routes** (`routes/auth.js`)
   - `POST /api/auth/signup` - User registration
   - `POST /api/auth/login` - User login
   - `GET /api/auth/verify-email` - Email verification
   - `POST /api/auth/resend-verification` - Resend verification email
   - `GET /api/auth/me` - Get current user profile

2. **Router Routes** (`routes/mikrotik-routers.js`)
   - `POST /api/routers` - Create new router (requires auth)
   - `GET /api/routers` - List user's routers (requires auth)
   - `GET /api/routers/:id` - Get router details (requires auth)
   - `DELETE /api/routers/:id` - Delete router (requires auth)
   - `GET /api/routers/billing/summary` - Get billing summary (requires auth)

## Features

### 1. User Signup & Email Verification

- Users sign up with email, password, and name
- Email verification token sent via Brevo
- 1-week free trial automatically activated
- JWT token issued on successful signup

### 2. Router Creation

- User creates router (requires email verification)
- System automatically:
  - Allocates unique ports (Winbox, SSH, API)
  - Creates WireGuard client
  - Creates subscription (trial or paid)
  - Sends email notification with router details

### 3. Billing System

- **Free Trial**: 1 week for new accounts
- **Monthly Billing**: $10/month per router (configurable via `ROUTER_MONTHLY_PRICE`)
- Automatic transition from trial to paid
- Daily billing job processes due subscriptions

### 4. Email Notifications

- **Signup**: Email verification link
- **Router Created**: Router details and access ports
- **Router Online**: Notification when router connects

### 5. Router Status Monitoring

- Checks WireGuard peers every 5 minutes
- Updates router status (pending/active/offline)
- Sends email when router comes online for first time

## Environment Variables

Add these to your `.env` file:

```bash
# JWT Secret (REQUIRED - change in production!)
JWT_SECRET=your-super-secret-jwt-key-change-this

# Brevo Email Service
BREVO_API_KEY=your-brevo-api-key
BREVO_SENDER_EMAIL=noreply@blackie-networks.com
BREVO_SENDER_NAME=Blackie Networks
BREVO_REPLY_TO_EMAIL=support@blackie-networks.com

# Pricing
ROUTER_MONTHLY_PRICE=10.00  # Price per router per month

# Service URLs (for email links)
SERVICE_URL_WIREGUARD=https://vpn.blackie-networks.com
SERVICE_FQDN_WIREGUARD=vpn.blackie-networks.com
```

## API Usage Examples

### 1. Sign Up

```bash
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe"
}
```

Response:
```json
{
  "success": true,
  "message": "User created successfully. Please check your email to verify your account.",
  "data": {
    "user": { ... },
    "token": "jwt-token-here"
  }
}
```

### 2. Verify Email

User clicks link in email:
```
GET /api/auth/verify-email?token=verification-token
```

### 3. Login

```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

### 4. Create Router

```bash
POST /api/routers
Authorization: Bearer jwt-token-here
Content-Type: application/json

{
  "name": "My Router",
  "notes": "Office router"
}
```

Response:
```json
{
  "success": true,
  "message": "MikroTik router created successfully",
  "data": {
    "router": {
      "id": "...",
      "name": "My Router",
      "vpnIp": "10.0.0.6/32",
      "ports": {
        "winbox": 3456,
        "ssh": 12345,
        "api": 23456
      },
      "publicUrl": {
        "winbox": "vpn.blackie-networks.com:3456",
        "ssh": "vpn.blackie-networks.com:12345",
        "api": "vpn.blackie-networks.com:23456"
      },
      "wireguardConfig": {
        "privateKey": "...",
        "publicKey": "...",
        "ip": "10.0.0.6/32"
      },
      "subscription": {
        "status": "trial",
        "planType": "trial",
        "pricePerMonth": 10.00,
        "nextBillingDate": "2025-03-07T00:00:00.000Z"
      }
    }
  }
}
```

### 5. Get Billing Summary

```bash
GET /api/routers/billing/summary
Authorization: Bearer jwt-token-here
```

## Background Jobs

1. **Billing Job**: Runs every 24 hours
   - Processes all due subscriptions
   - Transitions trials to paid
   - Updates billing cycles

2. **Router Status Monitoring**: Runs every 5 minutes (if WG_ENABLED=true)
   - Checks WireGuard peer status
   - Updates router online/offline status
   - Sends email when router comes online

## Port Ranges

Default port ranges (configurable in `utils/port-allocator.js`):
- **Winbox**: 3000-9999
- **SSH**: 10000-19999
- **API**: 20000-29999

## Security Notes

- All router routes require JWT authentication
- Email verification required before creating routers
- Passwords are hashed using bcrypt
- JWT tokens expire after 7 days (configurable)

## Next Steps

1. Install dependencies: `npm install bcryptjs jsonwebtoken`
2. Set `JWT_SECRET` in `.env` (use a strong random string)
3. Configure Brevo API key
4. Test signup/login flow
5. Test router creation
6. Monitor billing job logs

## Future Enhancements

- Payment gateway integration (Stripe, PayPal)
- Admin dashboard for user management
- Router usage statistics
- Automated port forwarding setup
- Reverse proxy service for router access
