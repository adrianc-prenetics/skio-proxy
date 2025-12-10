// api/skio.js - Enterprise-grade Skio proxy with Redis caching & rate limiting
import { kv } from '@vercel/kv';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  CACHE_TTL_SECONDS: 300,          // 5 minutes cache for subscription status
  RATE_LIMIT_WINDOW: 60,           // 1 minute window
  RATE_LIMIT_MAX: 10,              // 10 requests per window per email
  SKIO_GRAPHQL_URL: 'https://graphql.skio.com/v1/graphql',
  ALLOWED_ORIGINS: [
    'https://im8health.com',
    'https://www.im8health.com',
    'https://im8store.myshopify.com',
    'http://localhost:3000',
    'http://127.0.0.1:9292'
  ]
};

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  
  // ─────────────────────────────────────────────
  // CORS - Allow all origins for now (can restrict later)
  // ─────────────────────────────────────────────
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST for GraphQL
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─────────────────────────────────────────────
  // EXTRACT EMAIL
  // ─────────────────────────────────────────────
  const email = extractEmail(req.body);
  if (!email) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Email required in GraphQL variables'
    });
  }

  const emailHash = hashString(email.toLowerCase());
  const cacheKey = `skio:sub:${emailHash}`;
  const rateLimitKey = `skio:rl:${emailHash}`;

  // ─────────────────────────────────────────────
  // RATE LIMITING (graceful - continues if KV fails)
  // ─────────────────────────────────────────────
  try {
    const count = await kv.incr(rateLimitKey);
    
    if (count === 1) {
      await kv.expire(rateLimitKey, CONFIG.RATE_LIMIT_WINDOW);
    }

    res.setHeader('X-RateLimit-Limit', String(CONFIG.RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, CONFIG.RATE_LIMIT_MAX - count)));

    if (count > CONFIG.RATE_LIMIT_MAX) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: CONFIG.RATE_LIMIT_WINDOW
      });
    }
  } catch (e) {
    console.warn('Rate limit check failed:', e.message);
    // Continue without rate limiting
  }

  // ─────────────────────────────────────────────
  // CHECK CACHE
  // ─────────────────────────────────────────────
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Age', String(Math.floor((Date.now() - (cached.cachedAt || 0)) / 1000)));
      return res.status(200).json(cached);
    }
  } catch (e) {
    console.warn('Cache check failed:', e.message);
    // Continue without cache
  }

  res.setHeader('X-Cache', 'MISS');

  // ─────────────────────────────────────────────
  // CALL SKIO API
  // ─────────────────────────────────────────────
  const apiKey = process.env.SKIO_API_KEY;
  if (!apiKey) {
    console.error('SKIO_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const skioResponse = await fetch(CONFIG.SKIO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `API ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    const data = await skioResponse.json();

    // ─────────────────────────────────────────────
    // CACHE SUCCESSFUL RESPONSE
    // ─────────────────────────────────────────────
    if (skioResponse.ok && !data.errors) {
      const cacheData = {
        ...data,
        cached: true,
        cachedAt: Date.now()
      };

      try {
        await kv.set(cacheKey, cacheData, { ex: CONFIG.CACHE_TTL_SECONDS });
      } catch (e) {
        console.warn('Cache set failed:', e.message);
      }
    }

    return res.status(skioResponse.status).json(data);

  } catch (error) {
    console.error('Skio API error:', error.message);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to reach Skio API'
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function extractEmail(body) {
  if (!body) return null;

  // From variables
  if (body.variables?.email) {
    return body.variables.email;
  }

  // From inline query
  if (typeof body.query === 'string') {
    const match = body.query.match(/_eq:\s*"([^"]+@[^"]+)"/);
    if (match) return match[1];
  }

  return null;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}