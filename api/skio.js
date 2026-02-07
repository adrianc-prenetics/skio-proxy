// api/skio.js - Enterprise-grade Skio + Klaviyo proxy with Redis caching & rate limiting
// Updated: 2026 - Bulletproof gateway with stale-while-revalidate, circuit breaker, and request deduplication

// ═══════════════════════════════════════════════════════════════
// REDIS/KV INITIALIZATION (Upstash Redis via Vercel Marketplace)
// ═══════════════════════════════════════════════════════════════
let kv = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const kvModule = await import('@vercel/kv');
    kv = kvModule.kv;
  }
} catch (e) {
  console.warn('KV not available:', e.message);
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  // Cache settings
  CACHE_TTL_SECONDS: 300,              // 5 minutes fresh cache
  STALE_TTL_SECONDS: 3600,             // 1 hour stale cache (serve while revalidating)
  NEGATIVE_CACHE_TTL: 60,              // 1 minute cache for non-subscribers (shorter to catch new subs)
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 60,               // 1 minute window
  RATE_LIMIT_MAX: 10,                  // 10 requests per window per email
  
  // External APIs
  SKIO_GRAPHQL_URL: 'https://graphql.skio.com/v1/graphql',
  KLAVIYO_API_URL: 'https://a.klaviyo.com/api',
  KLAVIYO_REVISION: '2024-10-15',
  
  // Timeouts and retries - OPTIMIZED FOR UX
  API_TIMEOUT_MS: 20000,               // 20 second timeout per attempt (increased for slow Skio responses)
  SKIO_RETRY_COUNT: 2,                 // 2 retries (3 attempts total)
  SKIO_RETRY_DELAY_MS: 500,            // 0.5 second between retries (faster recovery)
  
  // Circuit breaker settings - MORE LENIENT
  CIRCUIT_BREAKER_THRESHOLD: 10,       // Open circuit after 10 consecutive failures
  CIRCUIT_BREAKER_RESET_MS: 15000,     // Try again after 15 seconds
  
  // Request deduplication window
  DEDUP_WINDOW_MS: 5000,               // Dedupe identical requests within 5 seconds
  
  // CORS
  ALLOWED_ORIGINS: [
    'https://im8health.com',
    'https://www.im8health.com',
    'https://im8official.myshopify.com',
    'http://localhost:3000',
    'http://127.0.0.1:9292'
  ]
};

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY STATE (per-instance, resets on cold start)
// ═══════════════════════════════════════════════════════════════
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  isOpen: false
};

// In-flight request deduplication map
const inFlightRequests = new Map();

// ═══════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════
function checkCircuitBreaker() {
  if (!circuitBreaker.isOpen) return true;
  
  // Check if enough time has passed to try again
  const timeSinceFailure = Date.now() - circuitBreaker.lastFailure;
  if (timeSinceFailure >= CONFIG.CIRCUIT_BREAKER_RESET_MS) {
    console.log('🔌 Circuit breaker: Half-open, allowing test request');
    return true; // Allow a test request
  }
  
  console.log('🔌 Circuit breaker: OPEN, rejecting request');
  return false;
}

function recordSuccess() {
  if (circuitBreaker.failures > 0 || circuitBreaker.isOpen) {
    console.log('🔌 Circuit breaker: Reset after success');
  }
  circuitBreaker.failures = 0;
  circuitBreaker.isOpen = false;
}

function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();
  
  if (circuitBreaker.failures >= CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreaker.isOpen = true;
    console.log(`🔌 Circuit breaker: OPENED after ${circuitBreaker.failures} failures`);
  }
}

// ═══════════════════════════════════════════════════════════════
// FETCH WITH TIMEOUT HELPER
// ═══════════════════════════════════════════════════════════════
async function fetchWithTimeout(url, options, timeoutMs = CONFIG.API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════
// FETCH WITH RETRY + CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════
async function fetchWithRetry(url, options, { 
  maxRetries = CONFIG.SKIO_RETRY_COUNT, 
  retryDelayMs = CONFIG.SKIO_RETRY_DELAY_MS,
  timeoutMs = CONFIG.API_TIMEOUT_MS 
} = {}) {
  // Check circuit breaker first
  if (!checkCircuitBreaker()) {
    throw new Error('Circuit breaker is open - Skio API temporarily unavailable');
  }
  
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`🔄 Retry attempt ${attempt}/${maxRetries} after ${retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        // Exponential backoff: double the delay for next retry
        retryDelayMs *= 2;
      }
      
      const response = await fetchWithTimeout(url, options, timeoutMs);
      
      // Retry on 5xx errors (server issues) but not 4xx (client errors)
      if (response.status >= 500 && attempt < maxRetries) {
        console.log(`⚠️ Skio returned ${response.status}, will retry...`);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      
      // Success! Record it for circuit breaker
      if (response.ok) {
        recordSuccess();
      }
      
      return response;
    } catch (error) {
      lastError = error;
      
      // Don't retry on abort (timeout) if we've exhausted retries
      if (error.name === 'AbortError') {
        console.log(`⏱️ Request timed out (attempt ${attempt + 1}/${maxRetries + 1})`);
        if (attempt >= maxRetries) {
          recordFailure();
          throw error;
        }
        continue;
      }
      
      // Network errors - retry
      if (attempt < maxRetries) {
        console.log(`⚠️ Network error: ${error.message}, will retry...`);
        continue;
      }
      
      recordFailure();
      throw error;
    }
  }
  
  recordFailure();
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// REQUEST DEDUPLICATION
// Prevents multiple identical requests from hitting Skio simultaneously
// ═══════════════════════════════════════════════════════════════
function getOrCreateInflightRequest(key, requestFn) {
  // Check if there's already an in-flight request for this key
  const existing = inFlightRequests.get(key);
  if (existing && (Date.now() - existing.timestamp) < CONFIG.DEDUP_WINDOW_MS) {
    console.log(`🔗 Deduplicating request for ${key}`);
    return existing.promise;
  }
  
  // Create new request
  const promise = requestFn().finally(() => {
    // Clean up after request completes (with small delay to catch rapid duplicates)
    setTimeout(() => {
      const current = inFlightRequests.get(key);
      if (current && current.promise === promise) {
        inFlightRequests.delete(key);
      }
    }, 100);
  });
  
  inFlightRequests.set(key, { promise, timestamp: Date.now() });
  return promise;
}

// ═══════════════════════════════════════════════════════════════
// STALE-WHILE-REVALIDATE CACHE
// Returns stale data immediately while refreshing in background
// ═══════════════════════════════════════════════════════════════
async function getWithSWR(cacheKey, fetchFn, options = {}) {
  const {
    freshTTL = CONFIG.CACHE_TTL_SECONDS,
    staleTTL = CONFIG.STALE_TTL_SECONDS
  } = options;
  
  if (!kv) {
    // No cache available, just fetch
    return { data: await fetchFn(), cacheStatus: 'BYPASS' };
  }
  
  try {
    const cached = await kv.get(cacheKey);
    
    if (cached) {
      const age = (Date.now() - (cached.cachedAt || 0)) / 1000;
      
      if (age < freshTTL) {
        // Fresh cache - return immediately
        return { data: cached, cacheStatus: 'HIT' };
      }
      
      if (age < staleTTL) {
        // Stale cache - return immediately but revalidate in background
        console.log(`📦 Serving stale cache (${Math.round(age)}s old), revalidating...`);
        
        // Fire-and-forget background revalidation
        fetchFn()
          .then(freshData => {
            if (freshData) {
              kv.set(cacheKey, { ...freshData, cached: true, cachedAt: Date.now() }, { ex: staleTTL })
                .catch(e => console.warn('Background cache update failed:', e.message));
            }
          })
          .catch(e => console.warn('Background revalidation failed:', e.message));
        
        return { data: cached, cacheStatus: 'STALE' };
      }
    }
    
    // No cache or expired - fetch fresh
    const freshData = await fetchFn();
    
    // Cache the result (fire-and-forget)
    if (freshData) {
      kv.set(cacheKey, { ...freshData, cached: true, cachedAt: Date.now() }, { ex: staleTTL })
        .catch(e => console.warn('Cache set failed:', e.message));
    }
    
    return { data: freshData, cacheStatus: 'MISS' };
    
  } catch (cacheError) {
    console.warn('Cache operation failed:', cacheError.message);
    // Fallback to direct fetch
    return { data: await fetchFn(), cacheStatus: 'ERROR' };
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  const startTime = Date.now();
  
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // ─────────────────────────────────────────────
  // HEALTH CHECK ENDPOINT
  // ─────────────────────────────────────────────
  if (req.method === 'GET') {
    // Calculate max possible request duration for clients to use
    // Formula: (timeout + delay) * attempts, with buffer
    const maxRequestMs = (CONFIG.API_TIMEOUT_MS + CONFIG.SKIO_RETRY_DELAY_MS) * (CONFIG.SKIO_RETRY_COUNT + 1);
    
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      circuitBreaker: circuitBreaker.isOpen ? 'open' : 'closed',
      cacheAvailable: !!kv,
      inFlightRequests: inFlightRequests.size,
      // Expose timing config so clients can set appropriate timeouts
      config: {
        maxRequestMs,
        recommendedClientTimeoutMs: maxRequestMs + 5000 // Add 5s buffer for network latency
      }
    };
    return res.status(200).json(health);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─────────────────────────────────────────────
  // ROUTE BASED ON ACTION
  // ─────────────────────────────────────────────
  const action = req.body?.action;
  
  try {
    let result;
    
    if (action === 'reserve-class') {
      result = await handleClassReservation(req, res);
    } else {
      result = await handleSkioQuery(req, res);
    }
    
    // Add timing header
    res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
    return result;
    
  } catch (error) {
    console.error('Unhandled error:', error);
    res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
    return res.status(500).json({ error: 'Internal server error' });
  }
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
  const dedupKey = `skio:${emailHash}`;

  // ─────────────────────────────────────────────
  // RATE LIMITING (if KV available)
  // ─────────────────────────────────────────────
  let rateLimitCount = 0;
  
  if (kv) {
    try {
      rateLimitCount = await kv.incr(rateLimitKey).catch(() => 0);
      if (rateLimitCount === 1) {
        kv.expire(rateLimitKey, CONFIG.RATE_LIMIT_WINDOW).catch(() => {});
      }
    } catch (e) {
      console.warn('Rate limit check failed:', e.message);
    }
  }

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', String(CONFIG.RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, CONFIG.RATE_LIMIT_MAX - rateLimitCount)));
  
  // Check rate limit
  if (rateLimitCount > CONFIG.RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: CONFIG.RATE_LIMIT_WINDOW });
  }

  // ─────────────────────────────────────────────
  // CHECK CIRCUIT BREAKER - Return stale cache if open
  // ─────────────────────────────────────────────
  if (circuitBreaker.isOpen && kv) {
    try {
      const staleCache = await kv.get(cacheKey);
      if (staleCache) {
        console.log('🔌 Circuit breaker open - serving stale cache');
        res.setHeader('X-Cache', 'STALE-CIRCUIT-OPEN');
        res.setHeader('X-Circuit-Breaker', 'open');
        return res.status(200).json(staleCache);
      }
    } catch (e) {
      console.warn('Stale cache fetch failed:', e.message);
    }
  }

  // ─────────────────────────────────────────────
  // FETCH WITH SWR + DEDUPLICATION
  // ─────────────────────────────────────────────
  const apiKey = process.env.SKIO_API_KEY;
  if (!apiKey) {
    console.error('SKIO_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Normalize the request body
  const normalizedBody = { ...req.body };
  if (normalizedBody.variables?.email) {
    normalizedBody.variables = { ...normalizedBody.variables, email: emailLower };
  }

  // Create the fetch function
  const fetchSkio = async () => {
    console.log('🔄 Calling Skio API for:', emailLower);
    const startTime = Date.now();
    
    const skioResponse = await fetchWithRetry(CONFIG.SKIO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `API ${apiKey}`
      },
      body: JSON.stringify(normalizedBody)
    });

    const elapsed = Date.now() - startTime;
    console.log(`⏱️ Skio API responded in ${elapsed}ms with status ${skioResponse.status}`);

    const data = await skioResponse.json();
    
    if (data.errors) {
      console.error('❌ Skio GraphQL errors:', JSON.stringify(data.errors));
    }
    
    return data;
  };

  try {
    // Use request deduplication to prevent thundering herd
    const { data, cacheStatus } = await getOrCreateInflightRequest(dedupKey, async () => {
      return getWithSWR(cacheKey, fetchSkio);
    });

    res.setHeader('X-Cache', cacheStatus);
    res.setHeader('X-Circuit-Breaker', circuitBreaker.isOpen ? 'open' : 'closed');
    
    return res.status(200).json(data);
    
  } catch (error) {
    // ─────────────────────────────────────────────
    // GRACEFUL DEGRADATION - Try stale cache on error
    // ─────────────────────────────────────────────
    if (kv) {
      try {
        const staleCache = await kv.get(cacheKey);
        if (staleCache) {
          console.log('⚠️ Skio API failed, serving stale cache');
          res.setHeader('X-Cache', 'STALE-ERROR');
          res.setHeader('X-Circuit-Breaker', circuitBreaker.isOpen ? 'open' : 'closed');
          return res.status(200).json(staleCache);
        }
      } catch (e) {
        console.warn('Stale cache fetch failed:', e.message);
      }
    }
    
    if (error.name === 'AbortError') {
      console.error('Skio API timeout after', CONFIG.API_TIMEOUT_MS, 'ms');
      return res.status(504).json({ 
        error: 'Upstream timeout',
        message: 'The subscription service is temporarily slow. Please try again.'
      });
    }
    
    if (error.message?.includes('Circuit breaker')) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'The subscription service is temporarily unavailable. Please try again shortly.',
        retryAfter: Math.ceil(CONFIG.CIRCUIT_BREAKER_RESET_MS / 1000)
      });
    }
    
    console.error('Skio API error:', error.name, error.message, error.stack);
    return res.status(502).json({ error: 'Upstream error', details: error.message });
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
  // RATE LIMIT (stricter for reservations) - if KV available
  // ─────────────────────────────────────────────
  if (kv) {
    const rateLimitKey = `reserve:rl:${emailHash}`;
    try {
      const count = await kv.incr(rateLimitKey);
      // Fire-and-forget expire (don't await)
      if (count === 1) {
        kv.expire(rateLimitKey, 300).catch(() => {}); // 5 minute window
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
  
  // Shared Klaviyo headers
  const klaviyoHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Klaviyo-API-Key ${klaviyoApiKey}`,
    'revision': CONFIG.KLAVIYO_REVISION
  };

  try {
    // ─────────────────────────────────────────────
    // STEP 1: Create/Update Profile (must complete first)
    // ─────────────────────────────────────────────
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
    
    const profileResponse = await fetchWithTimeout(`${CONFIG.KLAVIYO_API_URL}/profiles/`, {
      method: 'POST',
      headers: klaviyoHeaders,
      body: JSON.stringify(profilePayload)
    });

    if (profileResponse.ok) {
      const profileData = await profileResponse.json();
      console.log('✅ Profile created, ID:', profileData.data?.id);
    } else if (profileResponse.status === 409) {
      console.log('ℹ️ Profile already exists');
    } else {
      const errorText = await profileResponse.text();
      console.error('⚠️ Profile creation warning:', profileResponse.status, errorText);
    }

    // ─────────────────────────────────────────────
    // STEP 2 & 3: Subscribe to List + Track Event (PARALLEL)
    // ─────────────────────────────────────────────
    console.log('📤 Adding to list + tracking event in parallel...');
    
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

    // Run subscribe and event tracking in parallel
    const [subscribeResponse, eventResponse] = await Promise.all([
      fetchWithTimeout(`${CONFIG.KLAVIYO_API_URL}/profile-subscription-bulk-create-jobs/`, {
        method: 'POST',
        headers: klaviyoHeaders,
        body: JSON.stringify(subscribePayload)
      }).catch(e => ({ ok: false, error: e.message })),
      
      fetchWithTimeout(`${CONFIG.KLAVIYO_API_URL}/events/`, {
        method: 'POST',
        headers: klaviyoHeaders,
        body: JSON.stringify(eventPayload)
      }).catch(e => ({ ok: false, error: e.message }))
    ]);

    // Log results (non-blocking)
    if (subscribeResponse.ok || subscribeResponse.status === 202) {
      console.log('✅ Added to list');
    } else {
      console.warn('⚠️ List subscription warning:', subscribeResponse.status || subscribeResponse.error);
    }

    if (eventResponse.ok || eventResponse.status === 202) {
      console.log('✅ Event tracked');
    } else {
      console.warn('⚠️ Event tracking warning:', eventResponse.status || eventResponse.error);
    }

    console.log('🎉 Class reservation complete for:', emailLower);

    return res.status(200).json({
      success: true,
      message: 'Reservation confirmed',
      isSubscriber: true,
      reservedAt: timestamp
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ Klaviyo API timeout');
      return res.status(504).json({ error: 'Upstream timeout during reservation' });
    }
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

  const emailLower = email.toLowerCase().trim();
  const emailHash = hashString(emailLower);
  const cacheKey = `skio:verify:${emailHash}`;

  // Check cache first (for reservations, we want fresh data but can use short cache)
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt) < 60000) { // 1 minute cache for verification
        console.log('📦 Using cached verification result');
        return cached.hasQuarterly;
      }
    } catch (e) {
      console.warn('Verification cache check failed:', e.message);
    }
  }

  try {
    console.log('🔍 Verifying subscription for:', emailLower);
    
    // Use emailLower with _eq for fast indexed lookup (instead of slow _ilike)
    const response = await fetchWithRetry(CONFIG.SKIO_GRAPHQL_URL, {
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
                StorefrontUser: { emailLower: { _eq: $email } },
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

    // Cache the result
    if (kv) {
      kv.set(cacheKey, { hasQuarterly, cachedAt: Date.now() }, { ex: 60 })
        .catch(e => console.warn('Verification cache set failed:', e.message));
    }

    return hasQuarterly;

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ Subscription verification timeout after', CONFIG.API_TIMEOUT_MS, 'ms');
    } else {
      console.error('❌ Subscription verification error:', error.message);
    }
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
