// api/auth/review-request — admin approves or denies an access request.
// On approve: create/refresh the user with a generated temporary password and
// return that password ONCE so the admin can relay it. The password is only
// ever stored as a bcrypt hash.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { supaGet, supaPost, supaPatch, readJson } = require('../supa');

// Strong, human-copyable temp password (no ambiguous chars) + a digit & symbol.
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return out + '#' + (bytes[12] % 10);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readJson(req);
  if (!body) return res.status(400).json({ error: 'Invalid request' });
  const { id, action } = body;
  if (!id || !['approve', 'deny'].includes(action)) {
    return res.status(400).json({ error: 'id and action (approve|deny) required' });
  }

  const rq = await supaGet(`/rest/v1/access_requests?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const ar = Array.isArray(rq.json) && rq.json[0];
  if (!ar) return res.status(404).json({ error: 'Request not found' });

  const nowIso = new Date().toISOString();

  if (action === 'deny') {
    await supaPatch(`/rest/v1/access_requests?id=eq.${encodeURIComponent(id)}`, { status: 'denied', reviewed_at: nowIso });
    return res.status(200).json({ success: true, status: 'denied' });
  }

  // approve
  const tempPassword = genPassword();
  const hash = await bcrypt.hash(tempPassword, 12);
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString(); // 48h to first login

  const ex = await supaGet(`/rest/v1/users?email=eq.${encodeURIComponent(ar.email)}&select=id&limit=1`);
  const existing = Array.isArray(ex.json) && ex.json[0];
  if (existing) {
    const up = await supaPatch(`/rest/v1/users?id=eq.${existing.id}`, {
      password_hash: hash, must_change_password: true, temp_expires_at: expiresAt, updated_at: nowIso,
    });
    if (up.status >= 300) return res.status(502).json({ error: 'Could not update the account' });
  } else {
    const ins = await supaPost('/rest/v1/users', {
      email: ar.email, username: ar.email, password_hash: hash,
      role: 'viewer', must_change_password: true, temp_expires_at: expiresAt,
    });
    if (ins.status >= 300) return res.status(502).json({ error: 'Could not create the account' });
  }

  await supaPatch(`/rest/v1/access_requests?id=eq.${encodeURIComponent(id)}`, { status: 'approved', reviewed_at: nowIso });
  return res.status(200).json({ success: true, status: 'approved', email: ar.email, tempPassword, expiresAt });
};
