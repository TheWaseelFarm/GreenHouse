
const https = require('https');
const crypto = require('crypto');
const {
  calcVPD, calcDewPoint, calcHeatIndex, calcAbsHumidity, calcPSI
} = require('../_lib/metrics');
const { api: tuyaApi, parseSensor } = require('../_lib/tuya');

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
  const OUTDOOR_ID   = 'E7764046575F';   // Meter — outdoor (ambient)
  const FAR_END_ID   = 'E77646060A5C';   // Meter — far end of the house

  const W_CANOPY  = 0.70;
  const W_WETWALL = 0.30;

  try {
    // Fetch all devices in parallel
    const [meterData, hubData, leak1Data, outdoorData, farEndData] = await Promise.all([
      fetchDevice(TOKEN, SECRET, METER_PRO_ID),
      fetchDevice(TOKEN, SECRET, HUB_ID),
      fetchDevice(TOKEN, SECRET, WATER1_ID),
      fetchDevice(TOKEN, SECRET, OUTDOOR_ID),
      fetchDevice(TOKEN, SECRET, FAR_END_ID)
    ]);
 
    // Meter Pro — canopy zone
    const co2      = meterData.CO2 ?? meterData.co2 ?? 0;
    const temp     = parseFloat(meterData.temperature ?? 0);
    const humidity = parseFloat(meterData.humidity ?? 0);
    const vpd      = calcVPD(temp, humidity);
 
    // Hub 2 — wet wall zone
    const hub_temp     = parseFloat(hubData.temperature ?? 0);
    const hub_humidity = parseFloat(hubData.humidity ?? 0);

    // Outdoor (ambient) and far-end sensors. Use null (not 0) when a reading is
    // missing so a dropped sensor doesn't record a fake 0°C.
    const num = (v) => (v === undefined || v === null || v === '') ? null : parseFloat(v);
    const outdoor_temp     = num(outdoorData.temperature);
    const outdoor_humidity = num(outdoorData.humidity);
    const far_end_temp     = num(farEndData.temperature);
    const far_end_humidity = num(farEndData.humidity);

    // Tuya sensors (qxj temp/humidity). Non-fatal: if Tuya is unreachable we
    // still persist the SwitchBot reading rather than failing the whole cron.
    const TUYA_GH_ID  = 'bf18b89766f79e361d9trl';   // "The green house sensor"
    const TUYA_OUT_ID = 'bfe44012303d94cf4efxp1';   // "Outside water sensor"
    let tuyaGh = {}, tuyaOut = {};
    try {
      const [ghRes, outRes] = await Promise.all([
        tuyaApi('GET', `/v1.0/devices/${TUYA_GH_ID}/status`),
        tuyaApi('GET', `/v1.0/devices/${TUYA_OUT_ID}/status`)
      ]);
      if (ghRes && ghRes.success)  tuyaGh  = parseSensor(ghRes.result);
      if (outRes && outRes.success) tuyaOut = parseSensor(outRes.result);
    } catch (e) {
      console.warn('Tuya fetch failed (non-fatal):', e.message);
    }
    const tuya_gh_temp          = tuyaGh.temp ?? null;
    const tuya_gh_humidity      = tuyaGh.humidity ?? null;
    const tuya_out_temp         = tuyaOut.temp ?? null;
    const tuya_out_humidity     = tuyaOut.humidity ?? null;
    // External probes are water-temperature sensors: greenhouse probe = the
    // irrigation water feeding the plants; outside probe = the outdoor water tank.
    const water_temp_irrigation = tuyaGh.temp_external ?? null;
    const water_temp_outside    = tuyaOut.temp_external ?? null;

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
      plant_stress_index,
      outdoor_temp,
      outdoor_humidity,
      far_end_temp,
      far_end_humidity,
      tuya_gh_temp,
      tuya_gh_humidity,
      tuya_out_temp,
      tuya_out_humidity,
      water_temp_irrigation,
      water_temp_outside
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
      outdoor_temp, outdoor_humidity,
      far_end_temp, far_end_humidity,
      tuya_gh_temp, tuya_gh_humidity,
      tuya_out_temp, tuya_out_humidity,
      water_temp_irrigation, water_temp_outside,
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

