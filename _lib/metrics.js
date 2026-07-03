// _lib/metrics.js — Al-Waseel Farm greenhouse climate math.
//
// Pure, dependency-free functions. Everything here is deterministic:
// same inputs → same outputs, no I/O, no clock, no globals. That makes
// this module the safest place for the domain formulas and the natural
// unit under test.
//
//   t  = temperature in °C
//   rh = relative humidity in % (0–100)

// Saturation vapour pressure (kPa) via the Tetens equation.
function saturationVaporPressure(t) {
  return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
}

// Vapour pressure deficit (kPa) — the canopy transpiration driver.
function calcVPD(t, rh) {
  const svp = saturationVaporPressure(t);
  return parseFloat((svp * (1 - rh / 100)).toFixed(2));
}

// Dew point (°C) via the Magnus-Tetens approximation.
function calcDewPoint(t, rh) {
  const a = 17.27, b = 237.3;
  const alpha = (a * t) / (b + t) + Math.log(rh / 100);
  return parseFloat((b * alpha / (a - alpha)).toFixed(1));
}

// Heat index (°C) via the Rothfusz regression. Below 27°C the index is
// not meaningful, so we return the dry-bulb temperature unchanged.
function calcHeatIndex(t, rh) {
  if (t < 27) return t;
  return parseFloat((
    -8.78 + 1.61 * t + 2.34 * rh - 0.15 * t * rh
    - 0.012 * t * t - 0.016 * rh * rh
    + 0.002 * t * t * rh + 0.0007 * t * rh * rh
  ).toFixed(1));
}

// Absolute humidity (g/m³).
function calcAbsHumidity(t, rh) {
  const svp = saturationVaporPressure(t);
  return parseFloat((216.7 * (rh / 100 * svp * 1000) / (273.15 + t) / 1000).toFixed(1));
}

// Plant stress index (0–10). Additive score across VPD, temperature and
// humidity bands, clamped to 10.
function calcPSI(vpd, temp, hum) {
  let s = 0;
  if (vpd > 1.0 && vpd <= 1.3) s += 2;
  if (vpd > 1.3)               s += 4;
  if (temp > 22 && temp <= 26) s += 2;
  if (temp > 26)               s += 4;
  if (hum < 60 && hum >= 50)   s += 1;
  if (hum < 50)                s += 3;
  if (hum > 85)                s += 2;
  return Math.min(s, 10);
}

module.exports = {
  saturationVaporPressure,
  calcVPD,
  calcDewPoint,
  calcHeatIndex,
  calcAbsHumidity,
  calcPSI,
};
