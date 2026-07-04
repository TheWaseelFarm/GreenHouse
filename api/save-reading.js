const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(bodyChunks).toString('utf8');
    try {
      const data = JSON.parse(body);
      const payload = JSON.stringify({
        co2:                 data.co2,
        temperature:         data.temperature,
        humidity:            data.humidity,
        vpd:                 data.vpd,
        hub_temp:            data.hub_temp,
        hub_humidity:        data.hub_humidity,
        temp_weighted:       data.temp_weighted,
        hum_weighted:        data.hum_weighted,
        cooling_delta:       data.cooling_delta,
        heat_index:          data.heat_index,
        dew_point:           data.dew_point,
        plant_stress_index:  data.plant_stress_index,
        abs_humidity:        data.abs_humidity,
        water_leak_1:        data.water_leak_1 ?? false,
        water_leak_2:        data.water_leak_2 ?? false
      });

      const options = {
        hostname: SUPABASE_URL.replace('https://',''),
        path: '/rest/v1/readings',
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer':        'return=minimal',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const result = await new Promise((resolve, reject) => {
        const r = https.request(options, resp => {
          const chunks = [];
          resp.on('data', chunk => chunks.push(chunk));
          resp.on('end', () => resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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
