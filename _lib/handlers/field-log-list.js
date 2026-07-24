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

  let path = `/rest/v1/field_logs?select=id,created_at,log_date,author,location,activities,other_note,note,photo_urls&order=created_at.desc&limit=${limit}`;
  if (days > 0) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    path += `&created_at=gte.${since}`;
  }

  try {
    const r = await supaGet(path);
    if (!Array.isArray(r.json)) return res.status(502).json({ error: 'Could not load the journal.' });
    return res.status(200).json(r.json);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
