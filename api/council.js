const https = require('https');
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  const host = (process.env.SUPABASE_URL || '').replace('https://', '');
  const key  = process.env.SUPABASE_KEY || '';
 
  // ── GET: fetch last 20 decisions ──────────────────────────────────────────
  if (req.method === 'GET') {
    const options = {
      hostname: host,
      path: '/rest/v1/council_decisions?order=created_at.desc&limit=20',
      method: 'GET',
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    };
    const supaReq = https.request(options, supaRes => {
      let data = '';
      supaRes.on('data', c => data += c);
      supaRes.on('end', () => {
        try { res.status(200).json(JSON.parse(data)); }
        catch(e) { res.status(500).json({ error: 'parse error' }); }
      });
    });
    supaReq.on('error', e => res.status(500).json({ error: e.message }));
    supaReq.end();
    return;
  }
 
  // ── POST: save new decision ───────────────────────────────────────────────
  if (req.method === 'POST') {
    const { question, summary, agents_count } = req.body || {};
    if (!question || !summary) return res.status(400).json({ error: 'question and summary required' });
 
    const payload = JSON.stringify({ question, summary, agents_count: agents_count || 7 });
    const options = {
      hostname: host,
      path: '/rest/v1/council_decisions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Prefer': 'return=minimal'
      }
    };
    const supaReq = https.request(options, () => res.status(201).json({ success: true }));
    supaReq.on('error', e => res.status(500).json({ error: e.message }));
    supaReq.write(payload);
    supaReq.end();
    return;
  }
 
  res.status(405).json({ error: 'Method not allowed' });
};
 
