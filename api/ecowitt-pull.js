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

// Sensor map — verified Nov 2026 against physical placement:
//   WH46 (t_rh_aqi_combo) → greenhouse interior air. PROVISIONAL interim source
//     while the dedicated canopy probe (WN31 CH1) is removed pending a physical
//     location check — CH1 is intentionally NOT read.
//   WN31 CH2 (temp_and_humidity_ch2) → OUTDOOR air (confirmed outside the house;
//     it was previously, wrongly, mapped to a "wet wall" greenhouse zone).
//   WN34 temp_ch1 → irrigation/working tank; temp_ch2 → supply/storage tank
//     (confirmed by their daily temperature signatures).
//   WH51 soil_ch1 → substrate moisture at Line 4 · Tower 20 · Level 6; the
//     medium is volcanic rock + perlite, which the capacitance probe does not
//     reliably couple to, so the value is reported but treated as uncalibrated.
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

    // Greenhouse interior air — PROVISIONAL source: the WH46 combo, whose own
    // temperature/humidity live under t_rh_aqi_combo (not inside co2_aqi_combo).
    // The dedicated canopy probe (WN31 CH1) is deliberately not read until its
    // physical location is verified.
    const airTH = d.t_rh_aqi_combo || {};
    const temp     = validTemp(val(airTH.temperature));   // null when the sensor is offline
    const humidity = pct(val(airTH.humidity));
    const vpd      = (temp !== null && humidity !== null) ? calcVPD(temp, humidity) : null;

    // No zone blend: the former "wet wall" channel was the outdoor sensor (now
    // mapped below), so the greenhouse figure is the single interior reading.
    const temp_weighted = temp;
    const hum_weighted  = humidity;

    // CO2 (WH46 reports under co2_aqi_combo).
    const combo = d.co2_aqi_combo || {};
    const co2 = combo.co2 != null ? Math.round(val(combo.co2)) : 0;

    // Outdoor air — WN31 CH2, confirmed physically outside.
    const ch2 = d.temp_and_humidity_ch2 || {};
    const outdoor_temp     = validTemp(val(ch2.temperature));
    const outdoor_humidity = pct(val(ch2.humidity));

    // Inside-vs-outside delta (replaces the old canopy-vs-wetwall "cooling"
    // gradient, which was meaningless once CH2 was found to be outdoors).
    const cooling_delta = (temp !== null && outdoor_temp !== null)
      ? parseFloat((temp - outdoor_temp).toFixed(1)) : null;

    const water_temp_irrigation = val((d[WATER.irrigation] || {}).temperature);
    const water_temp_outside    = val((d[WATER.outside]    || {}).temperature);

    // Soil moisture (WH51, soil_ch1) as a 0-100% value. Uncalibrated for the
    // volcanic-rock + perlite medium — stored, but flagged on the dashboard.
    const soil_moisture = val((d.soil_ch1 || {}).soilmoisture);

    // No WH55 leak sensor in this build.
    const water_leak_1 = false;

    const canCalc = temp !== null && humidity !== null;
    const heat_index         = canCalc ? calcHeatIndex(temp, humidity) : null;
    const dew_point          = canCalc ? calcDewPoint(temp, humidity) : null;
    const abs_humidity       = canCalc ? calcAbsHumidity(temp, humidity) : null;
    const plant_stress_index = canCalc ? calcPSI(vpd, temp, humidity) : null;

    // If the gateway was offline this cycle, the Ecowitt API returns no channel
    // data and every mapped field is null/absent. Do NOT write a zero row then —
    // it pollutes history and makes the dashboard flip to "0 / offline". Skip
    // the insert; the dashboard keeps the last real reading and the freshness
    // banner handles the staleness.
    const hasData = temp !== null
      || (co2 && co2 > 0)
      || water_temp_irrigation !== null || water_temp_outside !== null
      || outdoor_temp !== null || soil_moisture !== null;
    if (!hasData) {
      return res.status(200).json({ success: true, source: 'ecowitt-api', skipped: 'no-sensor-data', saved: null });
    }

    const row = {
      co2,
      temperature: temp,
      humidity,
      vpd,
      hub_temp: null,            // "wet wall" retired — that channel was outdoor
      hub_humidity: null,
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
      far_end_temp: null,
      far_end_humidity: null,
      tuya_gh_temp: null, tuya_gh_humidity: null,
      tuya_out_temp: null, tuya_out_humidity: null,
      water_temp_irrigation,
      water_temp_outside,
      soil_moisture,
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
      const temp_valid = temp !== null;
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
      air: { temp, hum: humidity, source: 'WH46 (provisional)' },
      outdoor: { temp: outdoor_temp, hum: outdoor_humidity, source: 'WN31 CH2' },
      co2, temp, humidity, vpd,
      temp_weighted, hum_weighted, cooling_delta,
      outdoor_temp, outdoor_humidity,
      water_temp_irrigation, water_temp_outside,
      soil_moisture,
      alerts,
      flatlines: flatlines.map(x => x.key),
      saved: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

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
