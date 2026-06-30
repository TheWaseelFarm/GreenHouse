
const https = require('https');
const crypto = require('crypto');
 
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
    const svp      = 0.6108 * Math.exp((17.27 * temp) / (temp + 237.3));
    const vpd      = parseFloat((svp * (1 - humidity / 100)).toFixed(2));
 
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
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
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
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
 
// ── Calculations ───────────────────────────────────
function calcDewPoint(t, rh) {
  const a = 17.27, b = 237.3;
  const alpha = (a * t) / (b + t) + Math.log(rh / 100);
  return parseFloat((b * alpha / (a - alpha)).toFixed(1));
}
 
function calcHeatIndex(t, rh) {
  if (t < 27) return t;
  return parseFloat((-8.78 + 1.61*t + 2.34*rh - 0.15*t*rh - 0.012*t*t - 0.016*rh*rh + 0.002*t*t*rh + 0.0007*t*rh*rh).toFixed(1));
}
 
function calcAbsHumidity(t, rh) {
  const svp = 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  return parseFloat((216.7 * (rh / 100 * svp * 1000) / (273.15 + t) / 1000).toFixed(1));
}
 
function calcPSI(vpd, temp, hum) {
  let s = 0;
  if (vpd > 1.0 && vpd <= 1.3) s += 2;
  if (vpd > 1.3)                s += 4;
  if (temp > 22 && temp <= 26)  s += 2;
  if (temp > 26)                s += 4;
  if (hum < 60 && hum >= 50)   s += 1;
  if (hum < 50)                 s += 3;
  if (hum > 85)                 s += 2;
  return Math.min(s, 10);
}
 
