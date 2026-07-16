// api/auth/access-requests — admin: list the access requests filed from the
// login screen so the owner can see who asked and act on them. Read-only here;
// requires a valid session (the logged-in owner is the admin).

const https = require('https');
const { requireAuth } = require('../auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  // Admin-only (owner). Legacy role-less sessions count as admin; an explicit
  // non-admin role (approved viewer) is rejected.
  if ((req.user.role || 'admin') !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const host = (process.env.SUPABASE_URL || '').replace('https://', '');
  const key = process.env.SUPABASE_KEY || '';
  if (!host || !key) {
    console.error('Supabase env vars not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const path = '/rest/v1/access_requests?select=id,name,email,note,status,created_at,reviewed_at&order=created_at.desc&limit=50';
  const options = {
    hostname: host,
    path,
    method: 'GET',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
  };
  const supaReq = https.request(options, supaRes => {
    const chunks = [];
    supaRes.on('data', c => chunks.push(c));
    supaRes.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      try { res.status(200).json(JSON.parse(data)); }
      catch { res.status(500).json({ error: 'parse error' }); }
    });
  });
  supaReq.on('error', e => res.status(500).json({ error: e.message }));
  supaReq.end();
};
