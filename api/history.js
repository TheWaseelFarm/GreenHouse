const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const hours = req.query.hours || 24;
  const limit = req.query.limit || 500;

  const path = `/rest/v1/readings?select=*&recorded_at=gte.${new Date(Date.now() - hours*3600000).toISOString()}&order=recorded_at.asc&limit=${limit}`;

  const options = {
    hostname: SUPABASE_URL.replace('https://',''),
    path,
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  const data = await new Promise((resolve, reject) => {
    const r = https.get(options, resp => {
      let d = '';
      resp.on('data', chunk => d += chunk);
      resp.on('end', () => resolve(d));
    });
    r.on('error', reject);
  });

  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(data);
};
