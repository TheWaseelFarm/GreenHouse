const https = require('https');
const { requireAuth } = require('../_lib/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1/' + path);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : ''
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const limit = req.query.limit || 50;
    const r = await supabaseRequest('GET',
      `incidents?order=started_at.desc&limit=${limit}`);
    if (r.status >= 400) return res.status(500).json({ error: r.data });
    return res.json(Array.isArray(r.data) ? r.data : []);
  }

  if (req.method === 'POST') {
    // Parse body
    let body = req.body || {};
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    if (body.action === 'resolve') {
      // Get started_at
      const gr = await supabaseRequest('GET',
        `incidents?id=eq.${body.id}&select=started_at`);
      const inc = Array.isArray(gr.data) ? gr.data[0] : null;
      const now = new Date();
      const duration_minutes = inc
        ? Math.round((now - new Date(inc.started_at)) / 60000) : null;
      const r = await supabaseRequest('PATCH',
        `incidents?id=eq.${body.id}`,
        { ended_at: now.toISOString(), duration_minutes, resolved: true });
      return res.json({ ok: r.status < 400 });
    }

    const r = await supabaseRequest('POST', 'incidents', {
      started_at:      body.started_at || new Date().toISOString(),
      type:            body.type,
      severity:        body.severity,
      peak_temp:       body.peak_temp       || null,
      peak_humidity:   body.peak_humidity   || null,
      peak_vpd:        body.peak_vpd        || null,
      min_gradient:    body.min_gradient    || null,
      description:     body.description,
      description_ar:  body.description_ar,
      plant_impact:    body.plant_impact,
      plant_impact_ar: body.plant_impact_ar,
      stress_score:    body.stress_score    || 0,
      resolved:        false
    });
    const created = Array.isArray(r.data) ? r.data[0] : r.data;
    return res.json({ ok: r.status < 400, id: created?.id });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
