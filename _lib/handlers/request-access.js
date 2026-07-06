// api/auth/request-access — Al-Waseel Farm Dashboard
// Records a "Request access" submission from the login screen into the
// access_requests table for the admin to approve or deny later. No session
// required (this is how a prospective user asks for one), but it is rate
// limited per IP and validated. Never issues any credential by itself.

const https = require('https');

// In-memory rate limiter (resets on cold start — fine for a low-traffic form).
const attempts = {};
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (!attempts[ip]) attempts[ip] = [];
  attempts[ip] = attempts[ip].filter(t => now - t < WINDOW_MS);
  if (attempts[ip].length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  // Read the raw body (this function is behind the auth dispatcher, so the body
  // is not pre-parsed). UTF-8 decode to keep Arabic names intact.
  const chunks = [];
  await new Promise(resolve => {
    req.on('data', c => chunks.push(c));
    req.on('end', resolve);
  });

  let name, email, note;
  try {
    ({ name, email, note } = JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!name || !email || typeof name !== 'string' || typeof email !== 'string') {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  name = name.trim();
  email = email.trim();
  note = (typeof note === 'string' ? note : '').trim();
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Please enter your name' });
  if (!EMAIL_RE.test(email) || email.length > 160) return res.status(400).json({ error: 'Please enter a valid email' });
  if (note.length > 500) note = note.slice(0, 500);

  const host = (process.env.SUPABASE_URL || '').replace('https://', '');
  const key = process.env.SUPABASE_KEY || '';
  if (!host || !key) {
    console.error('Supabase env vars not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  attempts[ip].push(now); // count this submission toward the limit

  const payload = JSON.stringify({ name, email, note: note || null, status: 'pending' });
  const options = {
    hostname: host,
    path: '/rest/v1/access_requests',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'return=minimal'
    }
  };
  const supaReq = https.request(options, supaRes => {
    // Drain the response so the socket frees.
    supaRes.on('data', () => {});
    supaRes.on('end', () => {
      if (supaRes.statusCode >= 200 && supaRes.statusCode < 300) {
        return res.status(201).json({ success: true });
      }
      return res.status(502).json({ error: 'Could not record the request' });
    });
  });
  supaReq.on('error', e => res.status(500).json({ error: e.message }));
  supaReq.write(payload);
  supaReq.end();
};
