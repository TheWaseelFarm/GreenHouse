const cookie = require('cookie');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies['wf_session'];

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const p = jwt.verify(token, process.env.SESSION_SECRET);
    return res.status(200).json({ ok: true, role: p.role || 'admin', mustChange: !!p.mustChange, email: p.email || null });
  } catch {
    res.setHeader('Set-Cookie', 'wf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return res.status(401).json({ error: 'Session expired' });
  }
};
