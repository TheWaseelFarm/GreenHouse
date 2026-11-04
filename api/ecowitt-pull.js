// api/ecowitt-pull.js — pull the latest reading from the Ecowitt cloud API.
//
// Why pull instead of the gateway's direct push: the GW3000 "Customized"
// upload only speaks plain HTTP, but this dashboard (Vercel) is HTTPS-only, so
// a direct push cannot reach us. Instead the gateway keeps uploading to the
// Ecowitt cloud (which it already does), and we read it back over the free
// Ecowitt API v3 (HTTPS) and write it into the same `readings` table the rest
// of the app uses — identical columns, so the dashboard and charts just work.
//
// Triggered by the scheduler (Vercel cron / cron-job.org) with the same
// Bearer CRON_SECRET as the old SwitchBot/Tuya collector. Repointing that
// scheduler from /api/cron-save to /api/ecowitt-pull is what retires the old
// data source.
//
// Secrets live in Vercel env, never in the repo:
//   ECOWITT_APP_KEY, ECOWITT_API_KEY   (from the user's ecowitt.net account)
// The device MAC is not secret.

const https = require('https');
const {
  calcVPD, calcDewPoint, calcHeatIndex, calcAbsHumidity, calcPSI,
} = require('../_lib/metrics');
const { evaluateCriticals, detectFlatlines, processAlerts } = require('../_lib/alerts');

const MAC = process.env.ECOWITT_MAC || '1C:8F:57:37:33:2F';

// Which multi-channel (WN31) channel is which greenhouse zone, and the weight
// each carries in the greenhouse-wide average (normalised over the zones that
// actually reported, so a missing sensor never drags the average to zero).
const ZONES = [
  { key: 'canopy',  ch: 1, w: 0.40 },
  { key: 'wetwall', ch: 2, w: 0.30 },
  { key: 'farend',  ch: 3, w: 0.15 },
  { key: 'zone4',   ch: 4, w: 0.15 },
];
// WN34 water-temperature probes are reported as temp_chN.
const WATER = { irrigation: 'temp_ch1', outside: 'temp_ch2' };

module.exports = async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const APP = process.env.ECOWITT_APP_KEY;
  const KEY = process.env.ECOWITT_API_KEY;
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_KEY;
  if (!APP || !KEY) return res.status(500).json({ error: 'Ecowitt API keys not configured' });

  try {
    // temp_unitid=1 → °C, so no Fahrenheit conversion is needed here.
    const q = `application_key=${encodeURIComponent(APP)}&api_key=${encodeURIComponent(KEY)}`
      + `&mac=${encodeURIComponent(MAC)}&call_back=all&temp_unitid=1`;
    const raw = await httpGet('api.ecowitt.net', `/api/v3/device/real_time?${q}`, {});
    const json = JSON.parse(raw || '{}');
    if (Number(json.code) !== 0) {
      return res.status(502).json({ error: 'Ecowitt API error', code: json.code, msg: json.msg });
    }
    const d = json.data || {};

    // Each metric arrives as { time, unit, value }. Pull the numeric value.
    const val = (o) => { if (!o || o.value == null) return null; const n = parseFloat(o.value); return isNaN(n) ? null : n; };
    const validTemp = (n) => (n !== null && n > 5 && n < 60) ? n : null; // reject the 0/0 disconnected fault
    const pct = (n) => (n !== null && n > 0 && n <= 100) ? n : null;

    const zones = {};
    for (const z of ZONES) {
      const g = d['temp_and_humidity_ch' + z.ch] || {};
      zones[z.key] = { temp: validTemp(val(g.temperature)), hum: pct(val(g.humidity)), w: z.w };
    }
    const canopy = zones.canopy;

    // CO2 (WH46 reports under co2_aqi_combo). Fall back to its temp/hum for the
    // canopy if the dedicated canopy channel is missing.
    const combo = d.co2_aqi_combo || {};
    const co2 = combo.co2 != null ? Math.round(val(combo.co2)) : 0;
    // The WH46's own temperature/humidity live under t_rh_aqi_combo (not inside
    // co2_aqi_combo). Use them as a canopy fallback until the WN31 canopy
    // channel is paired, so the air sensor alone still lights up the dashboard.
    const airTH = d.t_rh_aqi_combo || {};
    if (canopy.temp === null) { const t = validTemp(val(airTH.temperature)); if (t !== null) canopy.temp = t; }
    if (canopy.hum === null)  { const h = pct(val(airTH.humidity)); if (h !== null) canopy.hum = h; }

    const temp     = canopy.temp !== null ? canopy.temp : 0;
    const humidity = canopy.hum  !== null ? canopy.hum  : 0;
    const vpd      = calcVPD(temp, humidity);

    const temp_weighted = weightedAvg(ZONES.map(z => zones[z.key]), 'temp', temp);
    const hum_weighted  = weightedAvg(ZONES.map(z => zones[z.key]), 'hum', humidity);

    const wet = zones.wetwall;
    const cooling_delta = (canopy.temp !== null && wet.temp !== null)
      ? parseFloat((canopy.temp - wet.temp).toFixed(1)) : null;

    const out = d.outdoor || {};
    const outdoor_temp     = validTemp(val(out.temperature));
    const outdoor_humidity = pct(val(out.humidity));

    const water_temp_irrigation = val((d[WATER.irrigation] || {}).temperature);
    const water_temp_outside    = val((d[WATER.outside]    || {}).temperature);

    // No WH55 leak sensor in this build.
    const water_leak_1 = false;

    const heat_index         = calcHeatIndex(temp, humidity);
    const dew_point          = calcDewPoint(temp, humidity);
    const abs_humidity       = calcAbsHumidity(temp, humidity);
    const plant_stress_index = calcPSI(vpd, temp, humidity);

    const row = {
      co2,
      temperature: temp,
      humidity,
      vpd,
      hub_temp: wet.temp,
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
      far_end_temp: zones.farend.temp,
      far_end_humidity: zones.farend.hum,
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

    // Same critical-alert engine as before. Non-fatal.
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
        const hist = await httpGet(
          SUPA_URL.replace('https://', ''),
          `/rest/v1/readings?select=recorded_at,water_temp_irrigation,water_temp_outside,temperature,humidity,hub_temp,co2&recorded_at=gte.${since}&order=recorded_at.desc&limit=120`,
          { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
        );
        flatlines = detectFlatlines(JSON.parse(hist || '[]'), { minHours: 6, minCount: 8 });
      } catch (e) { console.warn('Flatline check failed (non-fatal):', e.message); }
      alerts = await processAlerts({ criticals: [...criticals, ...flatlines], env: process.env, now: new Date() });
    } catch (e) {
      console.warn('Alert engine failed (non-fatal):', e.message);
      alerts = { error: e.message };
    }

    res.status(200).json({
      success: true,
      source: 'ecowitt-api',
      zones: Object.fromEntries(ZONES.map(z => [z.key, { temp: zones[z.key].temp, hum: zones[z.key].hum }])),
      co2, temp, humidity, vpd,
      temp_weighted, hum_weighted, cooling_delta,
      outdoor_temp, outdoor_humidity,
      water_temp_irrigation, water_temp_outside,
      alerts,
      flatlines: flatlines.map(x => x.key),
      saved: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Normalised weighted average over the zones whose `field` is non-null.
function weightedAvg(list, field, fallback) {
  let sum = 0, wsum = 0;
  for (const z of list) {
    if (z[field] !== null && z[field] !== undefined) { sum += z[field] * z.w; wsum += z.w; }
  }
  return wsum > 0 ? parseFloat((sum / wsum).toFixed(1)) : parseFloat(Number(fallback).toFixed(1));
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
