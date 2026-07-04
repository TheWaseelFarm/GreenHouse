
const https = require('https');
const crypto = require('crypto');
const {
  calcVPD, calcDewPoint, calcHeatIndex, calcAbsHumidity, calcPSI
} = require('../_lib/metrics');

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
 
  const TOKEN    = process.env.SWITCHBOT_TOKEN;
  const SECRET   = process.env.SWITCHBOT_SECRET;
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;
 
  const METER_PRO_ID = 'B0E9FED4881C';
  const HUB_ID       = 'FDD0AE072D7C';
  const WATER1_ID    = 'E7760186472B';
 
  const W_CANOPY  = 0.70;
  const W_WETWALL = 0.30;
 
  try {
    // Fetch all devices in parallel
    const [meterData, hubData, leak1Data] = await Promise.all([
      fetchDevice(TOKEN, SECRET, METER_PRO_ID),
      fetchDevice(TOKEN, SECRET, HUB_ID),
      fetchDevice(TOKEN, SECRET, WATER1_ID)
    ]);
 
    // Meter Pro — canopy zone
    const co2      = meterData.CO2 ?? meterData.co2 ?? 0;
    const temp     = parseFloat(meterData.temperature ?? 0);
    const humidity = parseFloat(meterData.humidity ?? 0);
    const vpd      = calcVPD(temp, humidity);
 
    // Hub 2 — wet wall zone
    const hub_temp     = parseFloat(hubData.temperature ?? 0);
    const hub_humidity = parseFloat(hubData.humidity ?? 0);
 
    // Weighted averages — 70% canopy + 30% wet wall
    const temp_weighted = parseFloat((temp * W_CANOPY + hub_temp * W_WETWALL).toFixed(1));
    const hum_weighted  = parseFloat((humidity * W_CANOPY + hub_humidity * W_WETWALL).toFixed(1));
 
    // Cooling gradient — how much warmer canopy is vs wet wall input (positive = normal)
    const cooling_delta = parseFloat((temp - hub_temp).toFixed(1));
 
    // Water leak detector
    const water_leak_1 = leak1Data.status === 'leak_detected' || leak1Data.detectionState === 'detected';
 
    // Derived metrics
    const heat_index         = calcHeatIndex(temp, humidity);
    const dew_point          = calcDewPoint(temp, humidity);
    const abs_humidity       = calcAbsHumidity(temp, humidity);
    const plant_stress_index = calcPSI(vpd, temp, humidity);
 
    // Save to Supabase
    const payload = JSON.stringify({
      co2,
      temperature:         temp,
      humidity,
      vpd,
      hub_temp,
      hub_humidity,
      temp_weighted,
      hum_weighted,
      cooling_delta,
      water_leak_1,
      heat_index,
      dew_point,
      abs_humidity,
      plant_stress_index
    });
 
    await httpPost(
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
 
    res.status(200).json({
      success: true,
      co2, temp, humidity, vpd,
      hub_temp, hub_humidity,
      temp_weighted, hum_weighted,
      cooling_delta,
      water_leak_1,
      saved: new Date().toISOString()
    });
 
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
 
// ── Fetch single device status ─────────────────────
async function fetchDevice(TOKEN, SECRET, deviceId) {
  const nonce     = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const sign      = crypto.createHmac('sha256', SECRET)
    .update(TOKEN + timestamp + nonce).digest('base64');
 
  const data = await httpGet('api.switch-bot.com', `/v1.1/devices/${deviceId}/status`, {
    'Authorization': TOKEN,
    'sign':          sign,
    'nonce':         nonce,
    't':             timestamp,
    'Content-Type':  'application/json'
  });
 
  return JSON.parse(data).body ?? {};
}
 
// ── HTTP helpers ───────────────────────────────────
function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers }, resp => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}
 
function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, resp => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

