// api/ingest.js — direct push endpoint for the Ecowitt gateway (GW3000, 868MHz).
//
// Hardware: GW3000 gateway (SD-card local buffer + Ethernet/Wi-Fi) + 4× WN31
// interior temp/humidity (channels 1-4) + 1× WN32 outdoor + WH46 CO2 (NDIR) +
// 2× WN34 waterproof water-temperature probes. All on 868 MHz for the Gulf.
//
// The gateway's "Customized" upload (Ecowitt protocol) POSTs a urlencoded
// key=value body straight to this URL on its own schedule — no SwitchBot /
// Tuya / vendor cloud in the path. That removes the single points of failure
// that silently froze the old sensors: if the farm has internet, the reading
// lands here; if it doesn't, the gateway buffers (SD card) and the offline
// banner fires.
//
// Setup on the gateway (Ecowitt app / WSView Plus → Customized):
//   Protocol: Ecowitt   Server/IP: green-house-iota.vercel.app
//   Path: /api/ingest?key=<INGEST_SECRET>   Port: 443   Interval: 60s
//
// Auth is a shared secret in the query string, because the gateway cannot set
// custom request headers. Optionally also pin the device by PASSKEY.
//
// Ecowitt sends temperatures in °F; everything here is converted to °C to match
// the rest of the dashboard. Field names follow the Ecowitt custom-server
// protocol (tempinf/humidityin, tempf/humidity for the WH32 outdoor, tempNf/
// humidityN for the WN31 channels, co2 for the WH46, tf_chN for WN34 probes).

const https = require('https');
const {
  calcVPD, calcDewPoint, calcHeatIndex, calcAbsHumidity, calcPSI,
} = require('../_lib/metrics');
const { evaluateCriticals, detectFlatlines, processAlerts } = require('../_lib/alerts');

// ── Sensor layout ──────────────────────────────────────────────────────────
// Which Ecowitt channel maps to which greenhouse zone. Edit these once the
// WN32 sensors are paired on-site (each sensor is assigned a channel number
// in the Ecowitt app). The weights feed the greenhouse-wide weighted average;
// they are normalised across whichever zones actually reported, so a missing
// sensor never drags the average toward zero.
const ZONES = [
  { key: 'canopy',  tf: 'temp1f', hf: 'humidity1', w: 0.40, col: { t: 'temperature',   h: 'humidity' } },
  { key: 'wetwall', tf: 'temp2f', hf: 'humidity2', w: 0.30, col: { t: 'hub_temp',       h: 'hub_humidity' } },
  { key: 'farend',  tf: 'temp3f', hf: 'humidity3', w: 0.15, col: { t: 'far_end_temp',   h: 'far_end_humidity' } },
  { key: 'zone4',   tf: 'temp4f', hf: 'humidity4', w: 0.15, col: null }, // 4th interior zone (no column yet)
];
// WN34 water-temperature probes.
const WATER = { irrigation: 'tf_ch1', outside: 'tf_ch2' };

module.exports = async (req, res) => {
  // ── Auth: shared secret in the query string ──
  const secret = process.env.INGEST_SECRET;
  const key = (req.query && req.query.key) || parseQueryKey(req.url);
  if (!secret || !safeEqual(key, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;

  try {
    const form = await readForm(req);

    // Optional second factor: pin to a known gateway by PASSKEY (its MAC hash).
    const allow = (process.env.ECOWITT_PASSKEYS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(form.PASSKEY)) {
      return res.status(401).json({ error: 'Unknown device' });
    }

    const f2c = (v) => { const n = parseFloat(v); return isNaN(n) ? null : parseFloat(((n - 32) * 5 / 9).toFixed(1)); };
    const pct = (v) => { const n = parseFloat(v); return (isNaN(n) || n <= 0 || n > 100) ? null : n; };
    // A running greenhouse is never at 0°C or 0% — reject the disconnected-probe
    // fault (0/0) and obvious faults the same way the live dashboard does.
    const validTemp = (n) => (n !== null && n > 5 && n < 60) ? n : null;

    // Per-zone interior readings.
    const zones = {};
    for (const z of ZONES) {
      zones[z.key] = { temp: validTemp(f2c(form[z.tf])), hum: pct(form[z.hf]), w: z.w };
    }
    const canopy = zones.canopy;

    // CO2 (WH45). Falls back to the WH45's own temp/hum for the canopy if the
    // dedicated canopy channel is absent.
    const co2 = form.co2 != null ? Math.round(parseFloat(form.co2)) : (form.co2_24h != null ? Math.round(parseFloat(form.co2_24h)) : 0);
    if (canopy.temp === null) { const t = validTemp(f2c(form.tf_co2)); if (t !== null) canopy.temp = t; }
    if (canopy.hum === null)  { const h = pct(form.humi_co2); if (h !== null) canopy.hum = h; }

    const temp     = canopy.temp !== null ? canopy.temp : 0;
    const humidity = canopy.hum  !== null ? canopy.hum  : 0;
    const vpd      = calcVPD(temp, humidity);

    // Weighted greenhouse averages over whichever interior zones reported.
    const temp_weighted = weightedAvg(ZONES.map(z => zones[z.key]), 'temp', temp);
    const hum_weighted  = weightedAvg(ZONES.map(z => zones[z.key]), 'hum', humidity);

    // Cooling gradient: canopy warmer than the wet-wall input is normal.
    const wet = zones.wetwall;
    const cooling_delta = (canopy.temp !== null && wet.temp !== null)
      ? parseFloat((canopy.temp - wet.temp).toFixed(1)) : null;

    // Outdoor (WH32 / gateway outdoor channel).
    const outdoor_temp     = validTemp(f2c(form.tempf));
    const outdoor_humidity = pct(form.humidity);

    // Water-temperature probes (WN34).
    const water_temp_irrigation = f2c(form[WATER.irrigation]);
    const water_temp_outside    = f2c(form[WATER.outside]);

    // Water-leak sensor (WH55), if present: "leak_chN" = "1" when wet.
    const water_leak_1 = ['leak_ch1', 'leak_ch2', 'leak_ch3', 'leak_ch4']
      .some(k => String(form[k]) === '1');

    // Derived metrics (identical formulas to the SwitchBot/Tuya path).
    const heat_index         = calcHeatIndex(temp, humidity);
    const dew_point          = calcDewPoint(temp, humidity);
    const abs_humidity       = calcAbsHumidity(temp, humidity);
    const plant_stress_index = calcPSI(vpd, temp, humidity);

    const row = {
      co2,
      temperature: temp,
      humidity,
      vpd,
      hub_temp:     wet.temp,
      hub_humidity: wet.hum,
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
      far_end_temp:     zones.farend.temp,
      far_end_humidity: zones.farend.hum,
      // Tuya columns stay null on the Ecowitt path.
      tuya_gh_temp: null, tuya_gh_humidity: null,
      tuya_out_temp: null, tuya_out_humidity: null,
      water_temp_irrigation,
      water_temp_outside,
    };

    await httpPost(
      SUPA_URL.replace('https://', ''),
      '/rest/v1/readings',
      JSON.stringify(row),
      {
        'Content-Type': 'application/json',
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        Prefer: 'return=minimal',
      }
    );

    // Same critical-alert engine as the cron path. Non-fatal.
    let alerts = { skipped: 'not-run' };
    let flatlines = [];
    try {
      const temp_valid = canopy.temp !== null;
      const criticals = evaluateCriticals(
        { temp_weighted, vpd, water_temp_irrigation, water_leak_1, temp_valid },
        new Date()
      );
      try {
        const since = new Date(Date.now() - 7 * 3600000).toISOString();
        const raw = await httpGet(
          SUPA_URL.replace('https://', ''),
          `/rest/v1/readings?select=recorded_at,water_temp_irrigation,water_temp_outside,temperature,humidity,hub_temp,co2&recorded_at=gte.${since}&order=recorded_at.desc&limit=120`,
          { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
        );
        flatlines = detectFlatlines(JSON.parse(raw || '[]'), { minHours: 6, minCount: 8 });
      } catch (e) { console.warn('Flatline check failed (non-fatal):', e.message); }
      alerts = await processAlerts({ criticals: [...criticals, ...flatlines], env: process.env, now: new Date() });
    } catch (e) {
      console.warn('Alert engine failed (non-fatal):', e.message);
      alerts = { error: e.message };
    }

    res.status(200).json({
      success: true,
      source: 'ecowitt',
      device: form.model || form.stationtype || null,
      zones: Object.fromEntries(ZONES.map(z => [z.key, { temp: zones[z.key].temp, hum: zones[z.key].hum }])),
      co2, temp, humidity, vpd,
      temp_weighted, hum_weighted, cooling_delta,
      outdoor_temp, outdoor_humidity,
      water_temp_irrigation, water_temp_outside,
      water_leak_1,
      alerts,
      flatlines: flatlines.map(x => x.key),
      saved: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────

// Normalised weighted average over the zones whose `field` is non-null.
// Falls back to `fallback` when nothing valid reported.
function weightedAvg(list, field, fallback) {
  let sum = 0, wsum = 0;
  for (const z of list) {
    if (z[field] !== null && z[field] !== undefined) { sum += z[field] * z.w; wsum += z.w; }
  }
  return wsum > 0 ? parseFloat((sum / wsum).toFixed(1)) : parseFloat(Number(fallback).toFixed(1));
}

// Read a urlencoded (or already-parsed) Ecowitt body into a plain object.
function readForm(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === 'string') return resolve(parseUrlEncoded(req.body));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(parseUrlEncoded(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function parseUrlEncoded(str) {
  const out = {};
  for (const [k, v] of new URLSearchParams(str)) out[k] = v;
  return out;
}

function parseQueryKey(url) {
  try { return new URL(url, 'http://x').searchParams.get('key'); } catch { return null; }
}

// Constant-time string compare that never throws on bad input.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const r = https.get({ hostname, path, headers }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    r.on('error', reject);
  });
}

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}
