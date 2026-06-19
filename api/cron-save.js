const https = require('https');
const crypto = require('crypto');

module.exports = async (req, res) => {
  // Security check — only allow Vercel cron calls
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const TOKEN  = process.env.SWITCHBOT_TOKEN;
  const SECRET = process.env.SWITCHBOT_SECRET;
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;

  try {
    // Step 1 — Get device list
    const nonce1     = crypto.randomUUID();
    const timestamp1 = Date.now().toString();
    const sign1      = crypto.createHmac('sha256', SECRET).update(TOKEN + timestamp1 + nonce1).digest('base64');

    const devices = await httpGet('api.switch-bot.com', '/v1.1/devices', {
      'Authorization': TOKEN, 'sign': sign1, 'nonce': nonce1, 't': timestamp1
    });

    const devData = JSON.parse(devices);
    const device  = (devData.body?.deviceList || []).find(d =>
      d.deviceType?.toLowerCase().includes('co2') ||
      d.deviceName?.toLowerCase().includes('co2') ||
      d.deviceName?.toLowerCase().includes('meter pro')
    );

    if (!device) return res.status(404).json({ error: 'No CO2 device found' });

    // Step 2 — Get device status
    const nonce2     = crypto.randomUUID();
    const timestamp2 = Date.now().toString();
    const sign2      = crypto.createHmac('sha256', SECRET).update(TOKEN + timestamp2 + nonce2).digest('base64');

    const status = await httpGet('api.switch-bot.com', `/v1.1/devices/${device.deviceId}/status`, {
      'Authorization': TOKEN, 'sign': sign2, 'nonce': nonce2, 't': timestamp2
    });

    const b        = JSON.parse(status).body;
    const co2      = b.CO2 ?? b.co2 ?? 0;
    const temp     = parseFloat(b.temperature ?? 0);
    const humidity = parseFloat(b.humidity ?? 0);
    const svp      = 0.6108 * Math.exp((17.27 * temp) / (temp + 237.3));
    const vpd      = parseFloat((svp * (1 - humidity / 100)).toFixed(2));

    // Step 3 — Save to Supabase
    const payload = JSON.stringify({ co2, temperature: temp, humidity, vpd });
    const result  = await httpPost(
      SUPA_URL.replace('https://', ''),
      '/rest/v1/readings',
      payload,
      {
        'Content-Type':  'application/json',
        'apikey':        SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Prefer':        'return=minimal'
      }
    );

    res.status(200).json({ success: true, co2, temp, humidity, vpd, saved: new Date().toISOString() });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers }, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, resp => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
