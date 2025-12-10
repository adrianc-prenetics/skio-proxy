// api/skio.js
export default async function handler(req, res) {
  // CORS - allow all im8 domains
  const allowedOrigins = [
    'https://im8health.com',
    'https://www.im8health.com',
    'https://im8store.myshopify.com',
    'http://localhost:3000'
  ];
  
  const origin = req.headers.origin;
  
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Official Skio GraphQL endpoint
  const skioUrl = 'https://graphql.skio.com/v1/graphql';

  // Verify API key exists
  const apiKey = process.env.SKIO_API_KEY;
  if (!apiKey) {
    console.error('SKIO_API_KEY environment variable not set');
    return res.status(500).json({ 
      error: 'Server configuration error',
      message: 'SKIO_API_KEY not configured'
    });
  }

  try {
    const fetchOptions = {
      method: 'POST', // GraphQL always uses POST
      headers: {
        'Content-Type': 'application/json',
        // CRITICAL: Skio expects lowercase "authorization" with "API " prefix
        'authorization': `API ${apiKey}`
      }
    };

    if (req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    console.log('Proxying to Skio:', skioUrl);
    
    const response = await fetch(skioUrl, fetchOptions);
    const data = await response.json();
    
    // Log for debugging (remove in production)
    if (!response.ok) {
      console.error('Skio API error:', response.status, data);
    }
    
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message 
    });
  }
}