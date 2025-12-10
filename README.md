# Skio API Proxy

A Vercel serverless proxy for the Skio API that keeps your API key secure on the server-side.

## Features

- ✅ API key stored securely in Vercel environment variables
- ✅ CORS restricted to your Shopify domain
- ✅ Frontend makes requests to proxy, not directly to Skio

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
