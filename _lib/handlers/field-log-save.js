// api/data/field-log-save — a field worker files a daily plant-log entry:
// photos taken in the greenhouse, the activities performed (from a checklist,
// with a free-text "other"), and any observations. Photos are uploaded to the
// public `plant-photos` Storage bucket under an unguessable path; the row in
// `field_logs` keeps the resulting public URLs plus the structured metadata.
// Any authenticated user may file a log.

const { requireAuth } = require('../auth');
const { supaPost, supaUpload, supaPublicUrl, readJson } = require('../supa');

const BUCKET = 'plant-photos';
const MAX_PHOTOS = 6;
const MAX_BYTES = 3 * 1024 * 1024; // per photo, after the browser has downscaled

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

// Decode a data URL / base64 image into { buffer, ext, contentType }, or null.
function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  let b64, type = 'jpeg';
  if (/^data:/i.test(dataUrl)) {
    const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (!m) return null; // a data URL of an unsupported type or malformed
    type = m[1].toLowerCase();
    b64 = m[2];
  } else {
    b64 = dataUrl; // bare base64 is treated as JPEG
  }
  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); } catch { return null; }
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  const ext = type === 'jpg' ? 'jpg' : type === 'jpeg' ? 'jpg' : type;
  return { buffer, ext, contentType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext) };
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

  const activities = Array.isArray(body.activities) ? body.activities.map(a => clip(a, 60)).filter(Boolean).slice(0, 20) : [];
  const other = clip(body.other, 200);
  const note = clip(body.note, 1000);
  const location = clip(body.location, 60);
  const log_date = /^\d{4}-\d{2}-\d{2}$/.test(body.log_date) ? body.log_date : new Date().toISOString().slice(0, 10);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];

  // An entry must carry at least a photo or some written observation.
  if (!photos.length && !activities.length && !other && !note) {
    return res.status(400).json({ error: 'Add at least a photo or a note.' });
  }

  const author = clip(req.user && (req.user.user || req.user.email), 120) || 'unknown';

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

    const row = { log_date, author, location, activities, other_note: other || null, note: note || null, photo_urls };
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
