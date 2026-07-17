// api/auth/access-requests — admin: list the access requests filed from the
// login screen, enriched with each approved account's current state. While an
// approved user has not yet set their own password, the temporary password is
// included so the admin can re-copy it (it is cleared on first password change
// and after it expires). Admin-only.

const { requireAuth } = require('../auth');
const { supaGet } = require('../supa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  // Admin-only (owner). Legacy role-less sessions count as admin.
  if ((req.user.role || 'admin') !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Supabase env vars not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const rq = await supaGet('/rest/v1/access_requests?select=id,name,email,note,status,created_at,reviewed_at&order=created_at.desc&limit=50');
    if (!Array.isArray(rq.json)) return res.status(502).json({ error: 'Could not load requests' });

    // Map approved accounts by email so we can surface the still-valid temp
    // password (only until the user changes it) and the account state.
    const usersRes = await supaGet('/rest/v1/users?select=email,temp_password,must_change_password,temp_expires_at&limit=200');
    const byEmail = {};
    if (Array.isArray(usersRes.json)) for (const u of usersRes.json) byEmail[(u.email || '').toLowerCase()] = u;

    const now = Date.now();
    const out = rq.json.map(r => {
      const u = byEmail[(r.email || '').toLowerCase()];
      let account = null, temp_password = null;
      if (u) {
        const expired = u.temp_expires_at && new Date(u.temp_expires_at).getTime() < now;
        if (!u.must_change_password) account = 'active';        // user set their own password
        else if (expired) account = 'expired';                  // temp lapsed, needs re-approval
        else { account = 'awaiting-first-login'; temp_password = u.temp_password || null; }
      }
      return { ...r, account, temp_password };
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
