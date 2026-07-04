const https = require('https');
const { requireAuth } = require('../_lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!requireAuth(req, res)) return;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const hours = req.query.hours || 24;
  const limit = req.query.limit || 500;

  const since = new Date(Date.now() - hours * 3600000).toISOString();

 const path = `/rest/v1/readings?select=recorded_at,co2,temperature,humidity,vpd,hub_temp,hub_humidity,temp_weighted,hum_weighted,water_leak_1,water_leak_2&recorded_at=gte.${since}&order=recorded_at.desc&limit=${limit}`;

  const options = {
    hostname: SUPABASE_URL.replace('https://', ''),
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
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    r.on('error', reject);
  });

  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(data);
};
