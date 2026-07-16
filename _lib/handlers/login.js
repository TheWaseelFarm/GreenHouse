// api/auth/login.js — Al-Waseel Farm Dashboard
// Validates username + password, issues httpOnly JWT session cookie.
// Credentials stored in Vercel env vars — never in code.

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const cookie = require('cookie');

// Simple in-memory rate limiter (resets on cold start — good enough for single-user)
const attempts = {};
const MAX_ATTEMPTS = 5;
const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes

module.exports = async (req, res) => {
  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

  // Rate limit check
  const now = Date.now();
  if (!attempts[ip]) attempts[ip] = [];
  attempts[ip] = attempts[ip].filter(t => now - t < WINDOW_MS);
  if (attempts[ip].length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  // Parse body
  const bodyChunks = [];
  await new Promise(resolve => {
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', resolve);
  });
  const body = Buffer.concat(bodyChunks).toString('utf8');

  let username, password;
  try {
    ({ username, password } = JSON.parse(body));
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Basic input validation
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username.length > 64 || password.length > 128) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!SESSION_SECRET) {
    console.error('SESSION_SECRET not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const issueSession = (payload) => {
    const token = jwt.sign({ ...payload, iat: Math.floor(Date.now() / 1000) }, SESSION_SECRET, { expiresIn: '8h' });
    res.setHeader('Set-Cookie', cookie.serialize('wf_session', token, {
      httpOnly: true, secure: true, sameSite: 'strict', maxAge: 8 * 60 * 60, path: '/'
    }));
  };

  // ── 1) The owner/admin account, from env vars ──────────────────────────────
  const DASHBOARD_USER          = (process.env.DASHBOARD_USER || '').trim();
  // Trim the hash: pasting into the Vercel dashboard often appends a stray
  // newline/space, which silently breaks bcrypt.compare.
  const DASHBOARD_PASSWORD_HASH = (process.env.DASHBOARD_PASSWORD_HASH || '').trim();
  // Optional plaintext fallback so setup can't be broken by a mis-pasted hash.
  const DASHBOARD_PASSWORD      = process.env.DASHBOARD_PASSWORD;

  if (DASHBOARD_USER && (DASHBOARD_PASSWORD_HASH || DASHBOARD_PASSWORD) &&
      timingSafeEqual(username, DASHBOARD_USER)) {
    const passMatch = DASHBOARD_PASSWORD_HASH
      ? await bcrypt.compare(password, DASHBOARD_PASSWORD_HASH)
      : timingSafeEqual(password, DASHBOARD_PASSWORD);
    if (passMatch) {
      issueSession({ user: username, role: 'admin', mustChange: false });
      return res.status(200).json({ success: true, role: 'admin' });
    }
    // Username matched admin but password didn't — fail (don't fall through).
    attempts[ip].push(now);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // ── 2) Approved accounts, from the users table ─────────────────────────────
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) try {
    const { supaGet } = require('../supa');
    const v = encodeURIComponent(username);
    const r = await supaGet(`/rest/v1/users?or=(email.eq.${v},username.eq.${v})&select=*&limit=1`);
    const u = Array.isArray(r.json) && r.json[0];
    if (u && u.password_hash && await bcrypt.compare(password, u.password_hash)) {
      // Expired temporary password — must be re-issued by the admin.
      if (u.must_change_password && u.temp_expires_at && new Date(u.temp_expires_at) < new Date()) {
        attempts[ip].push(now);
        return res.status(401).json({ error: 'Temporary password expired. Ask the admin to re-issue access.' });
      }
      issueSession({ user: u.username || u.email, email: u.email, role: u.role || 'viewer', mustChange: !!u.must_change_password });
      return res.status(200).json({ success: true, role: u.role || 'viewer', mustChange: !!u.must_change_password });
    }
  } catch (e) {
    console.error('User lookup failed:', e.message);
  }

  attempts[ip].push(now);
  return res.status(401).json({ error: 'Invalid credentials' });
};

// Constant-time string comparison
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    // Still run comparison to avoid timing leak on length
    bcrypt.compareSync(a, '$2a$10$invalidhashfortimingpurposes000000000000000000000000000');
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return require('crypto').timingSafeEqual(bufA, bufB);
}
