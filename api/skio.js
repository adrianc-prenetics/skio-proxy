export default async function handler(req, res) {
  // CORS - restrict to your domain
  const allowedOrigins = ['https://im8store.myshopify.com', 'https://your-domain.com'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Get path from query parameter
  const skioPath = req.query.path || '';
  const skioUrl = `https://api.skio.com/${skioPath}`;

  try {
    const response = await fetch(skioUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Skio-API-Key': process.env.SKIO_API_KEY
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Proxy error', details: error.message });
  }
}
