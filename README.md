# Skio API Proxy

A Vercel serverless proxy for the Skio API that keeps your API key secure on the server-side.

## Features

- ✅ API key stored securely in Vercel environment variables
- ✅ CORS restricted to your Shopify domain
- ✅ Frontend makes requests to proxy, not directly to Skio
- ✅ Manual exception rules UI for CS team (`/admin/exceptions`)

## Setup

### 1. Deploy to Vercel

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel

# Add environment variable
vercel env add SKIO_API_KEY
# Enter your API key when prompted

# Add CS admin token for exception management
vercel env add EXCEPTIONS_ADMIN_TOKEN

# Redeploy with env var
vercel --prod
```

### 2. Update Frontend

In your frontend code (e.g., `assets/vip-gateway.js`), change fetch URLs:

```javascript
// Before:
fetch('/apps/skio/storefront/api/customer/subscriptions', ...)

// After:
fetch('https://your-vercel-app.vercel.app/api/skio/storefront/api/customer/subscriptions', ...)
```

**Important:** Remove all `X-Skio-API-Key` headers from frontend code - the proxy adds them server-side.

## Local Development

```bash
# Copy environment example
cp .env.example .env.local

# Add your API key to .env.local
# Then run:
vercel dev
```

## Allowed Origins

Update the `allowedOrigins` array in `api/skio/[...path].js` to include your domains:

```javascript
const allowedOrigins = ['https://im8store.myshopify.com', 'https://your-domain.com'];
```

## CS Exception Rules Admin

After deploy, open:

`https://your-vercel-app.vercel.app/admin/exceptions`

What it does:
- Add manual `ALLOW` or `DENY` rules by customer email
- Optional expiration timestamp and note
- `ALLOW` rules can specify `cadenceWeeks` (defaults to 4)
- Rules are stored in Vercel KV under `skio:exceptions:rules`

Rule behavior:
- `/api/skio` checks these rules first; `ALLOW` returns a synthetic active subscription, `DENY` returns no subscriptions
- `reserve-class` server-side verification also checks rules first
