const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const limit = parseInt(req.query.limit) || 50;
    const { data, error } = await supabase
      .from('incidents')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      if (typeof req.body === 'string') body = JSON.parse(req.body);
      else body = req.body || {};
    } catch(e) { body = {}; }

    if (body.action === 'resolve') {
      const now = new Date();
      const { data: inc } = await supabase
        .from('incidents').select('started_at').eq('id', body.id).single();
      const duration_minutes = inc
        ? Math.round((now - new Date(inc.started_at)) / 60000) : null;
      const { error } = await supabase.from('incidents').update({
        ended_at: now.toISOString(), duration_minutes, resolved: true
      }).eq('id', body.id);
      return res.json({ ok: !error, error: error?.message });
    }

    const { data, error } = await supabase.from('incidents').insert([{
      started_at:      body.started_at || new Date().toISOString(),
      type:            body.type,
      severity:        body.severity,
      peak_temp:       body.peak_temp       || null,
      peak_humidity:   body.peak_humidity   || null,
      peak_vpd:        body.peak_vpd        || null,
      min_gradient:    body.min_gradient    || null,
      description:
