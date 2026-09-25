// api/data/field-log-save — files a Daily Plant Log entry. Two kinds:
//   • monitoring — crop + nutrient/water + plant-health reading
//   • treatment  — pest control & prevention (spray/drench + PHI safety window)
// Both carry a per-plant location index (Line/Tower/Level/Outlet → plant_code),
// optional photos (uploaded to the public `plant-photos` bucket), and the live
// greenhouse climate snapshot at the moment of logging. Any authenticated user
// may file a log.

const { requireAuth } = require('../auth');
const { supaPost, supaUpload, supaPublicUrl, readJson } = require('../supa');

const BUCKET = 'plant-photos';
const MAX_PHOTOS = 6;
const MAX_BYTES = 3 * 1024 * 1024; // per photo, after the browser has downscaled

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const nn = (s, n) => clip(s, n) || null; // trimmed string or null

// A finite number within [min,max], else null (so a blank field stores NULL).
function num(v, min, max) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}
const int = (v, min, max) => { const n = num(v, min, max); return n == null ? null : Math.round(n); };

// Build the canonical per-plant code from the location parts, e.g. L3-T12-Lv4-O2.
// Includes each level only as deep as it is provided.
function plantCode(line, tower, level, outlet) {
  if (line == null || tower == null) return null;
  let c = `L${line}-T${tower}`;
  if (level != null) c += `-Lv${level}`;
  if (outlet != null) c += `-O${outlet}`;
  return c;
}

// safety_end = log_date + phi_days (تاريخ انتهاء الأمان), as YYYY-MM-DD.
function addDays(isoDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !days) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  let b64, type = 'jpeg';
  if (/^data:/i.test(dataUrl)) {
    const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (!m) return null;
    type = m[1].toLowerCase();
    b64 = m[2];
  } else {
    b64 = dataUrl;
  }
  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); } catch { return null; }
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  const ext = type === 'jpg' ? 'jpg' : type === 'jpeg' ? 'jpg' : type;
  return { buffer, ext, contentType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) };
}

// Keep only the fields we expect from the client's climate snapshot.
function cleanClimate(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const k of ['temp', 'humidity', 'vpd', 'co2', 'water_temp']) {
    const v = num(c[k], -50, 5000);
    if (v != null) out[k] = v;
  }
  if (typeof c.recorded_at === 'string') out.recorded_at = c.recorded_at.slice(0, 40);
  return Object.keys(out).length ? out : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Supabase env vars not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid body' });

  const log_type = body.log_type === 'treatment' ? 'treatment' : 'monitoring';
  const activities = Array.isArray(body.activities) ? body.activities.map(a => clip(a, 60)).filter(Boolean).slice(0, 20) : [];
  const other = clip(body.other, 200);
  const note = clip(body.note, 1000);
  const log_date = /^\d{4}-\d{2}-\d{2}$/.test(body.log_date) ? body.log_date : new Date().toISOString().slice(0, 10);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];

  // Location index → plant_code.
  const line = int(body.line, 1, 999);
  const tower = int(body.tower, 1, 9999);
  const level = int(body.level, 1, 99);
  const outlet = int(body.outlet, 1, 4);
  const plant_code = plantCode(line, tower, level, outlet);
  const location = clip(body.location, 60) || plant_code || '';

  const climate = cleanClimate(body.climate);

  const row = {
    log_type, log_date, location, activities,
    other_note: other || null, note: note || null,
    line, tower, level, outlet, plant_code,
    climate,
    author: clip(req.user && (req.user.user || req.user.email), 120) || 'unknown',
  };

  let hasData = photos.length || activities.length || other || note;

  if (log_type === 'monitoring') {
    row.variety = nn(body.variety, 60);
    row.growth_stage = nn(body.growth_stage, 40);
    row.vigor = int(body.vigor, 1, 5);
    row.feed_ec = num(body.feed_ec, 0, 10);
    row.feed_ph = num(body.feed_ph, 0, 14);
    row.drain_ec = num(body.drain_ec, 0, 10);
    row.drain_ph = num(body.drain_ph, 0, 14);
    row.water_temp = num(body.water_temp, 0, 60);
    row.irrigation = nn(body.irrigation, 200);
    row.fertilizer = nn(body.fertilizer, 200);
    hasData = hasData || row.vigor != null || row.growth_stage || row.feed_ec != null ||
      row.feed_ph != null || row.drain_ec != null || row.drain_ph != null ||
      row.water_temp != null || row.irrigation || row.fertilizer;
  } else {
    row.pesticide = nn(body.pesticide, 120);
    row.active_ingredient = nn(body.active_ingredient, 120);
    row.dose = nn(body.dose, 60);
    row.method = nn(body.method, 40);
    row.pest = nn(body.pest, 120);
    row.phi_days = int(body.phi_days, 0, 365);
    row.operator = nn(body.operator, 120);
    row.safety_end = addDays(log_date, row.phi_days);
    hasData = hasData || row.pesticide || row.pest || row.active_ingredient;
  }

  if (!hasData) {
    return res.status(400).json({
      error: log_type === 'treatment'
        ? 'Add at least the pesticide or the pest/reason.'
        : 'Add at least a photo, a reading, or a note.',
    });
  }

  try {
    const photo_urls = [];
    for (let i = 0; i < photos.length; i++) {
      const img = decodeImage(photos[i]);
      if (!img) return res.status(400).json({ error: 'A photo was invalid or too large (max 3MB each).' });
      const rand = Math.random().toString(36).slice(2, 10);
      const objectPath = `${log_date.replace(/-/g, '/')}/${Date.now()}-${i}-${rand}.${img.ext}`;
      const up = await supaUpload(BUCKET, objectPath, img.buffer, img.contentType);
      if (up.status >= 300) {
        console.error('Storage upload failed', up.status, up.text);
        return res.status(502).json({ error: 'Photo upload failed. Is the plant-photos bucket created?' });
      }
      photo_urls.push(supaPublicUrl(BUCKET, objectPath));
    }
    row.photo_urls = photo_urls;

    const ins = await supaPost('/rest/v1/field_logs', row);
    if (ins.status >= 300) {
      console.error('field_logs insert failed', ins.status, ins.text);
      return res.status(502).json({ error: 'Could not save the log entry.' });
    }
    const saved = Array.isArray(ins.json) ? ins.json[0] : ins.json;
    return res.status(200).json({ success: true, entry: saved });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
