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
  const WATER1_ID    = 'E65584467069';
  const WATER2_ID    = 'E77760186472B';

  const W_CANOPY  = 0.70;
  const W_WETWALL = 0.30;

  try {
    // Fetch all devices in parallel
    const [meterData, hubData, leak1Data, leak2Data] = await Promise.all([
      fetchDevice(TOKEN, SECRET, METER_PRO_ID),
      fetchDevice(TOKEN, SECRET, HUB_ID),
      fetchDevice(TOKEN, SECRET, WATER1_ID),
      fetchDevice(TOKEN, SECRET, WATER2_ID)
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

    // Water leak detectors
    const water_leak_1 =
