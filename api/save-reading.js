const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const payload = JSON.stringify({
        co2: data.co2,
        temperature: data.temperature,
        humidity: data.humidity,
        vpd: data.vpd,
        heat_index: data.heat_index,
        dew_point: data.dew_point,
        plant_stress_index: data.plant_stress_index,
        abs_humidity: data.abs_humidity
      });

      const options = {
        hostname: SUPABASE_URL.replace('https://',''),
        path: '/rest/v1/readings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const result = await new Promise((resolve, reject) => {
        const r = https.request(options, resp => {
          let d = '';
          resp.on('data', chunk => d += chunk);
          resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
        });
        r.on('error', reject);
        r.write(payload);
        r.end();
      });

      res.status(200).json({ success: true, status: result.status });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
};
