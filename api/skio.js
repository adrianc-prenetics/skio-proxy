export default async function handler(req, res) {
  // CORS - allow all im8 domains
  const allowedOrigins = [
    'https://im8health.com',
    'https://www.im8health.com',
    'https://im8store.myshopify.com',
    'http://localhost:3000'
  ];
  
  const origin = req.headers.origin;
  
  // Check if origin matches any allowed origin
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

  // Get path from query parameter (set by Vercel rewrite)
  const skioPath = req.query.path || '';
  const skioUrl = `https://api.skio.com/${skioPath}`;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Skio-API-Key': process.env.SKIO_API_KEY
      }
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(skioUrl, fetchOptions);
    const data = await response.json();
    
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Proxy error', 
      message: error.message 
    });
  }
}
