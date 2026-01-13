// api/skio.js - Enterprise-grade Skio + Klaviyo proxy with Redis caching & rate limiting
import { kv } from '@vercel/kv';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  CACHE_TTL_SECONDS: 300,          // 5 minutes cache for subscription status
  RATE_LIMIT_WINDOW: 60,           // 1 minute window
  RATE_LIMIT_MAX: 10,              // 10 requests per window per email
  SKIO_GRAPHQL_URL: 'https://graphql.skio.com/v1/graphql',
  KLAVIYO_API_URL: 'https://a.klaviyo.com/api',
  KLAVIYO_REVISION: '2024-10-15',
  ALLOWED_ORIGINS: [
    'https://im8health.com',
    'https://www.im8health.com',
    'https://im8official.myshopify.com',
    'http://localhost:3000',
    'http://127.0.0.1:9292'
  ]
};

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  
  // ─────────────────────────────────────────────
  // CORS
  // ─────────────────────────────────────────────
  const origin = req.headers.origin;
  if (origin && CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    console.warn('Request from unlisted origin:', origin);
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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─────────────────────────────────────────────
  // ROUTE BASED ON ACTION
  // ─────────────────────────────────────────────
  const action = req.body?.action;
  
  if (action === 'reserve-class') {
    return handleClassReservation(req, res);
  }
  
  // Default: Skio subscription check (existing behavior)
  return handleSkioQuery(req, res);
}

// ═══════════════════════════════════════════════════════════════
// SKIO SUBSCRIPTION CHECK
// ═══════════════════════════════════════════════════════════════
async function handleSkioQuery(req, res) {
  const email = extractEmail(req.body);
  if (!email) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Email required in GraphQL variables'
    });
  }

  // IMPORTANT: Normalize email to lowercase for consistent matching
  const emailLower = email.toLowerCase().trim();
  const emailHash = hashString(emailLower);
  const cacheKey = `skio:sub:${emailHash}`;
  const rateLimitKey = `skio:rl:${emailHash}`;

  // Rate limiting
  try {
    const count = await kv.incr(rateLimitKey);
    if (count === 1) {
      await kv.expire(rateLimitKey, CONFIG.RATE_LIMIT_WINDOW);
    }
    res.setHeader('X-RateLimit-Limit', String(CONFIG.RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, CONFIG.RATE_LIMIT_MAX - count)));
    if (count > CONFIG.RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: CONFIG.RATE_LIMIT_WINDOW });
    }
  } catch (e) {
    console.warn('Rate limit check failed:', e.message);
  }

  // Check cache
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }
  } catch (e) {
    console.warn('Cache check failed:', e.message);
  }

  res.setHeader('X-Cache', 'MISS');

  // Call Skio API
  const apiKey = process.env.SKIO_API_KEY;
  if (!apiKey) {
    console.error('SKIO_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    // IMPORTANT: Normalize email in the GraphQL query to match server-side verification
    // This ensures client-side check and server-side verification use the same email format
    const normalizedBody = { ...req.body };
    if (normalizedBody.variables?.email) {
      normalizedBody.variables = { ...normalizedBody.variables, email: emailLower };
    }
    
    const skioResponse = await fetch(CONFIG.SKIO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `API ${apiKey}`
      },
      body: JSON.stringify(normalizedBody)
    });

    const data = await skioResponse.json();

    if (skioResponse.ok && !data.errors) {
      try {
        await kv.set(cacheKey, { ...data, cached: true, cachedAt: Date.now() }, { ex: CONFIG.CACHE_TTL_SECONDS });
      } catch (e) {
        console.warn('Cache set failed:', e.message);
      }
    }

    return res.status(skioResponse.status).json(data);
  } catch (error) {
    console.error('Skio API error:', error.message);
    return res.status(502).json({ error: 'Upstream error' });
  }
}

// ═══════════════════════════════════════════════════════════════
// CLASS RESERVATION (Server-side gated)
// ═══════════════════════════════════════════════════════════════
async function handleClassReservation(req, res) {
  const { email, moduleData, firstName, lastName, locationData } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const emailLower = email.toLowerCase().trim();
  const emailHash = hashString(emailLower);

  // ─────────────────────────────────────────────
  // RATE LIMIT (stricter for reservations)
  // ─────────────────────────────────────────────
  const rateLimitKey = `reserve:rl:${emailHash}`;
  try {
    const count = await kv.incr(rateLimitKey);
    if (count === 1) {
      await kv.expire(rateLimitKey, 300); // 5 minute window
    }
    if (count > 5) { // Only 5 reservation attempts per 5 minutes
      return res.status(429).json({ 
        error: 'Too many reservation attempts',
        message: 'Please wait a few minutes before trying again'
      });
    }
  } catch (e) {
    console.warn('Rate limit check failed:', e.message);
  }

  // ─────────────────────────────────────────────
  // 🔒 CRITICAL: SERVER-SIDE SUBSCRIPTION VERIFICATION
  // ─────────────────────────────────────────────
  const hasQuarterly = await verifyQuarterlySubscription(emailLower);
  
  if (!hasQuarterly) {
    console.log(`🚫 Class reservation BLOCKED: ${emailLower} - not a quarterly subscriber`);
    return res.status(403).json({
      error: 'Subscription required',
      message: 'Live sessions are reserved for IM8 Quarterly subscribers.',
      isSubscriber: false
    });
  }

  console.log(`✅ Class reservation APPROVED: ${emailLower} - verified quarterly subscriber`);

  // ─────────────────────────────────────────────
  // SUBMIT TO KLAVIYO (server-side)
  // ─────────────────────────────────────────────
  const klaviyoApiKey = process.env.KLAVIYO_PRIVATE_KEY;
  if (!klaviyoApiKey) {
    console.error('KLAVIYO_PRIVATE_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const timestamp = new Date().toISOString();
  const klaviyoListId = process.env.KLAVIYO_90DAY_LIST_ID || 'Xnm4ac';

  try {
    // 1. Create/Update Profile
    const profilePayload = {
      data: {
        type: 'profile',
        attributes: {
          email: emailLower,
          ...(firstName && { first_name: firstName }),
          ...(lastName && { last_name: lastName }),
          ...(locationData?.city && {
            location: {
              city: locationData.city,
              region: locationData.region,
              country: locationData.country,
              zip: locationData.zip,
              latitude: locationData.latitude,
              longitude: locationData.longitude,
              timezone: locationData.timezone
            }
          }),
          properties: {
            '90_day_class_reserved': true,
            '90_day_class_reserved_at': timestamp,
            '90_day_class_module': moduleData?.moduleIndex || '1',
            '90_day_class_module_label': moduleData?.moduleLabel || '',
            '90_day_class_session_title': moduleData?.sessionTitle || '',
            '90_day_class_expert': moduleData?.expertName || '',
            '90_day_class_date': moduleData?.dateText || '',
            'subscription_verified_server_side': true
          }
        }
      }
    };

    console.log('📤 Creating/updating Klaviyo profile...');
    
    const profileResponse = await fetch(`${CONFIG.KLAVIYO_API_URL}/profiles/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Klaviyo-API-Key ${klaviyoApiKey}`,
        'revision': CONFIG.KLAVIYO_REVISION
      },
      body: JSON.stringify(profilePayload)
    });

    let profileId = null;
    
    if (profileResponse.ok) {
      const profileData = await profileResponse.json();
      profileId = profileData.data?.id;
      console.log('✅ Profile created, ID:', profileId);
    } else if (profileResponse.status === 409) {
      // Profile exists, that's fine
      console.log('ℹ️ Profile already exists');
    } else {
      const errorText = await profileResponse.text();
      console.error('⚠️ Profile creation warning:', profileResponse.status, errorText);
    }

    // 2. Subscribe to List
    console.log('📤 Adding to 90-Day list...');
    
    const subscribePayload = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: {
            data: [{
              type: 'profile',
              attributes: {
                email: emailLower,
                subscriptions: {
                  email: { marketing: { consent: 'SUBSCRIBED' } }
                }
              }
            }]
          }
        },
        relationships: {
          list: {
            data: { type: 'list', id: klaviyoListId }
          }
        }
      }
    };

    const subscribeResponse = await fetch(`${CONFIG.KLAVIYO_API_URL}/profile-subscription-bulk-create-jobs/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Klaviyo-API-Key ${klaviyoApiKey}`,
        'revision': CONFIG.KLAVIYO_REVISION
      },
      body: JSON.stringify(subscribePayload)
    });

    if (subscribeResponse.ok || subscribeResponse.status === 202) {
      console.log('✅ Added to list');
    } else {
      console.warn('⚠️ List subscription warning:', subscribeResponse.status);
    }

    // 3. Track Event
    console.log('📤 Tracking reservation event...');
    
    const eventPayload = {
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: {
              type: 'metric',
              attributes: { name: '90 Day Class Reserved' }
            }
          },
          profile: {
            data: {
              type: 'profile',
              attributes: { email: emailLower }
            }
          },
          properties: {
            module_number: moduleData?.moduleIndex || '1',
            module_label: moduleData?.moduleLabel || '',
            session_title: moduleData?.sessionTitle || '',
            expert_name: moduleData?.expertName || '',
            expert_role: moduleData?.expertRole || '',
            session_date: moduleData?.dateText || '',
            reserved_at: timestamp,
            verified_server_side: true
          },
          time: timestamp
        }
      }
    };

    const eventResponse = await fetch(`${CONFIG.KLAVIYO_API_URL}/events/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Klaviyo-API-Key ${klaviyoApiKey}`,
        'revision': CONFIG.KLAVIYO_REVISION
      },
      body: JSON.stringify(eventPayload)
    });

    if (eventResponse.ok || eventResponse.status === 202) {
      console.log('✅ Event tracked');
    } else {
      console.warn('⚠️ Event tracking warning:', eventResponse.status);
    }

    console.log('🎉 Class reservation complete for:', emailLower);

    return res.status(200).json({
      success: true,
      message: 'Reservation confirmed',
      isSubscriber: true,
      reservedAt: timestamp
    });

  } catch (error) {
    console.error('❌ Klaviyo submission error:', error.message);
    return res.status(500).json({ error: 'Failed to complete reservation' });
  }
}

// ═══════════════════════════════════════════════════════════════
// VERIFY QUARTERLY SUBSCRIPTION (server-side)
// ═══════════════════════════════════════════════════════════════
async function verifyQuarterlySubscription(email) {
  const apiKey = process.env.SKIO_API_KEY;
  if (!apiKey) {
    console.error('SKIO_API_KEY not configured for verification');
    return false;
  }

  try {
    // Normalize email for logging, but use _ilike for case-insensitive matching
    const emailLower = email.toLowerCase().trim();
    console.log('🔍 Verifying subscription for:', emailLower);
    
    const response = await fetch(CONFIG.SKIO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `API ${apiKey}`
      },
      body: JSON.stringify({
        query: `
          query CheckQuarterly($email: String!) {
            Subscriptions(
              where: {
                StorefrontUser: { email: { _ilike: $email } },
                status: { _eq: "ACTIVE" }
              },
              limit: 10
            ) {
              status
              BillingPolicy {
                interval
                intervalCount
              }
            }
          }
        `,
        variables: { email: emailLower }
      })
    });

    if (!response.ok) {
      console.log('❌ Skio API returned:', response.status);
      return false;
    }

    const data = await response.json();
    
    if (data.errors) {
      console.log('❌ Skio GraphQL errors:', data.errors);
      return false;
    }

    const subscriptions = data.data?.Subscriptions || [];
    console.log('📋 Found', subscriptions.length, 'active subscriptions for', emailLower);
    
    // Log all subscriptions for debugging
    subscriptions.forEach((sub, i) => {
      const policy = sub.BillingPolicy || {};
      console.log(`  📦 Sub ${i + 1}: status=${sub.status}, interval=${policy.interval}, count=${policy.intervalCount}`);
    });
    
    const hasQuarterly = subscriptions.some(sub => {
      const status = (sub.status || '').toUpperCase();
      if (status !== 'ACTIVE') return false;
      
      const policy = sub.BillingPolicy || {};
      const interval = (policy.interval || '').toUpperCase();
      const count = parseInt(policy.intervalCount) || 0;
      
      // Quarterly = 12 weeks OR 3 months OR ~90 days
      const isQuarterly = (
        (interval === 'WEEK' && count === 12) ||
        (interval === 'MONTH' && count === 3) ||
        (interval === 'DAY' && count >= 84 && count <= 90)
      );
      
      if (isQuarterly) {
        console.log('✅ Found quarterly:', interval, count);
      }
      
      return isQuarterly;
    });

    if (!hasQuarterly && subscriptions.length > 0) {
      console.log('⚠️ User has subscriptions but none are quarterly');
    }

    return hasQuarterly;

  } catch (error) {
    console.error('❌ Subscription verification error:', error.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function extractEmail(body) {
  if (!body) return null;
  if (body.variables?.email) return body.variables.email;
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