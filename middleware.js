// middleware.js — Al-Waseel Farm Dashboard
// Runs on every request before it hits any page or API.
// Public routes: /login, /api/auth/login  (everything else requires valid session)

const cookie = require('cookie');
const jwt    = require('jsonwebtoken');

const PUBLIC_PATHS = ['/login', '/api/auth/login'];

module.exports = async function middleware(req, res, next) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Always allow public paths and static assets
  if (
    PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '?')) ||
    pathname.startsWith('/assets/') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.ico')
  ) {
    return next();
  }

  // Parse session cookie
  const cookies = cookie.parse(req.headers.cookie || '');
  const token   = cookies['wf_session'];

  if (!token) {
    return redirectToLogin(req, res);
  }

  try {
    const payload = jwt.verify(token, process.env.SESSION_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    // Token invalid or expired
    res.setHeader('Set-Cookie', 'wf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return redirectToLogin(req, res);
  }
};

function redirectToLogin(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  // API calls get 401, not a redirect
  if (pathname.startsWith('/api/')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.writeHead(302, { Location: '/login' });
  res.end();
}
