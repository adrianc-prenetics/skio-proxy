let kv = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const kvModule = await import('@vercel/kv');
    kv = kvModule.kv;
  } else if (process.env.EXCEPTIONS_KV_REDIS_URL || process.env.REDIS_URL) {
    const redisUrl = process.env.EXCEPTIONS_KV_REDIS_URL || process.env.REDIS_URL;
    const redisModule = await import('ioredis');
    const Redis = redisModule.default;
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false
    });

    kv = {
      async get(key) {
        const value = await redis.get(key);
        if (value === null || value === undefined) return null;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      },
      async set(key, value, options = {}) {
        const payload = typeof value === 'string' ? value : JSON.stringify(value);
        if (options?.ex) {
          return redis.set(key, payload, 'EX', options.ex);
        }
        return redis.set(key, payload);
      }
    };
  }
} catch (e) {
  console.warn('KV not available for exceptions API:', e.message);
}

const EXCEPTION_RULES_KEY = 'skio:exceptions:rules';

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return (req.headers['x-admin-token'] || '').trim();
}

function isAuthorized(req) {
  const expected = (process.env.EXCEPTIONS_ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  return getTokenFromRequest(req) === expected;
}

function ensureKV(res) {
  if (kv) return true;
  res.status(500).json({
    error: 'KV not configured',
    message: 'Manual exceptions require Vercel KV/Upstash to be configured.'
  });
  return false;
}

async function readRules() {
  const rules = await kv.get(EXCEPTION_RULES_KEY);
  return rules && typeof rules === 'object' ? rules : {};
}

async function writeRules(rules) {
  await kv.set(EXCEPTION_RULES_KEY, rules);
}

function toList(rules) {
  return Object.entries(rules)
    .map(([email, rule]) => ({ email, ...rule }))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ensureKV(res)) return;

  try {
    if (req.method === 'GET') {
      const rules = await readRules();
      return res.status(200).json({ rules: toList(rules) });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const email = normalizeEmail(body.email);
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      const action = (body.action || 'ALLOW').toUpperCase() === 'DENY' ? 'DENY' : 'ALLOW';
      const cadenceWeeksRaw = Number.parseInt(body.cadenceWeeks, 10);
      const cadenceWeeks = Number.isFinite(cadenceWeeksRaw) && cadenceWeeksRaw > 0 ? cadenceWeeksRaw : 4;
      const note = String(body.note || '').trim().slice(0, 500);
      let expiresAt = null;
      if (body.expiresAt) {
        const expiresDate = new Date(body.expiresAt);
        if (Number.isNaN(expiresDate.getTime())) {
          return res.status(400).json({ error: 'Invalid expiresAt date' });
        }
        expiresAt = expiresDate.toISOString();
      }
      const addedBy = String(body.addedBy || 'cs-team').trim().slice(0, 100);
      const now = new Date().toISOString();

      const rules = await readRules();
      rules[email] = {
        action,
        cadenceWeeks,
        note,
        addedBy,
        expiresAt,
        active: true,
        createdAt: rules[email]?.createdAt || now,
        updatedAt: now
      };
      await writeRules(rules);

      return res.status(200).json({ success: true, rule: { email, ...rules[email] } });
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const email = normalizeEmail(body.email || req.query?.email);
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      const rules = await readRules();
      if (!rules[email]) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      delete rules[email];
      await writeRules(rules);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Exceptions API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
