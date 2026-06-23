// api/auth/logout.js — clears session cookie and redirects to login

const cookie = require('cookie');

module.exports = async (req, res) => {
  // Clear the session cookie
  const cleared = cookie.serialize('wf_session', '', {
    httpOnly: true,
    secure:   true,
    sameSite: 'strict',
    maxAge:   0,
    path:     '/'
  });
  res.setHeader('Set-Cookie', cleared);
  res.writeHead(302, { Location: '/login' });
  res.end();
};
