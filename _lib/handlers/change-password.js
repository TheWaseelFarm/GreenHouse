// api/auth/change-password — an approved user sets a new password (required on
// first login after a temp password). Verifies the current password, stores the
// new one as a bcrypt hash, clears the must-change flag, and re-issues the
// session without the mustChange marker.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { requireAuth } = require('../auth');
const { supaGet, supaPatch, readJson } = require('../supa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = req.user.email;
  if (!email) {
    // The env-var admin has no DB row; their password lives in Vercel env vars.
    return res.status(400).json({ error: 'Password change applies to approved accounts only.' });
  }

  const body = await readJson(req);
  if (!body) return res.status(400).json({ error: 'Invalid request' });
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'New password must be 8–128 characters.' });
  }

  const r = await supaGet(`/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`);
  const u = Array.isArray(r.json) && r.json[0];
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (!await bcrypt.compare(currentPassword, u.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const up = await supaPatch(`/rest/v1/users?id=eq.${u.id}`, {
    password_hash: hash, temp_password: null, must_change_password: false, temp_expires_at: null, updated_at: new Date().toISOString(),
  });
  if (up.status >= 300) return res.status(502).json({ error: 'Could not save the new password' });

  const token = jwt.sign(
    { user: u.username || u.email, email: u.email, role: u.role || 'viewer', mustChange: false, iat: Math.floor(Date.now() / 1000) },
    process.env.SESSION_SECRET, { expiresIn: '8h' }
  );
  res.setHeader('Set-Cookie', cookie.serialize('wf_session', token, {
    httpOnly: true, secure: true, sameSite: 'strict', maxAge: 8 * 60 * 60, path: '/'
  }));
  return res.status(200).json({ success: true });
};
