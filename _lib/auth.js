// _lib/auth.js — shared session validator for all API routes
// Import this at the top of every protected API file.

const cookie = require('cookie');
const jwt    = require('jsonwebtoken');

/**
 * Validates the session cookie on an API request.
 * Returns true if valid, sends 401 and returns false if not.
 */
function requireAuth(req, res) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token   = cookies['wf_session'];

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  try {
    const payload = jwt.verify(token, process.env.SESSION_SECRET);
    req.user = payload;
    return true;
  } catch {
    res.setHeader('Set-Cookie', 'wf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.status(401).json({ error: 'Session expired' });
    return false;
  }
}

module.exports = { requireAuth };
