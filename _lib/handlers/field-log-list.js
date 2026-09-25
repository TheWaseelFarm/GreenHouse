// api/data/field-log-list — return recent plant-log entries (photos +
// activities + observations) for the Field Journal view and the Operations
// Report. Any authenticated user may read them. Optional ?days=N narrows the
// window; ?limit caps the count.

const { requireAuth } = require('../auth');
const { supaGet } = require('../supa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Supabase env vars not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const limit = Math.min(parseInt(req.query && req.query.limit, 10) || 200, 500);
  const days = parseInt(req.query && req.query.days, 10);
  const q = req.query || {};

  const cols = 'id,created_at,log_date,log_type,author,location,line,tower,level,outlet,plant_code,'
    + 'activities,other_note,note,photo_urls,climate,'
    + 'variety,growth_stage,vigor,feed_ec,feed_ph,drain_ec,drain_ph,water_temp,irrigation,fertilizer,'
    + 'pesticide,active_ingredient,dose,method,pest,phi_days,safety_end,operator';
  let path = `/rest/v1/field_logs?select=${cols}&order=created_at.desc&limit=${limit}`;
  if (days > 0) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    path += `&created_at=gte.${since}`;
  }
  // Optional filters. `type` = monitoring|treatment; `plant_code` exact; `line`
  // exact; `safety=open` = pre-harvest windows that have not yet expired.
  if (q.type === 'monitoring' || q.type === 'treatment') path += `&log_type=eq.${q.type}`;
  if (typeof q.plant_code === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(q.plant_code)) path += `&plant_code=eq.${q.plant_code}`;
  if (/^\d{1,3}$/.test(String(q.line || ''))) path += `&line=eq.${q.line}`;
  if (q.safety === 'open') path += `&safety_end=gte.${new Date().toISOString().slice(0, 10)}`;


  try {
    const r = await supaGet(path);
    if (!Array.isArray(r.json)) return res.status(502).json({ error: 'Could not load the journal.' });
    return res.status(200).json(r.json);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
