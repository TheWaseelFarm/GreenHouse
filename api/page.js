const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  const url = req.url.split('?')[0];

  // Serve login page without auth
  if (url === '/login' || url === '/login.html') {
    const filePath = path.join(process.cwd(), 'login.html');
    const html = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
    return;
  }

  // Check session
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies['wf_session'];

  if (!token) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  try {
    jwt.verify(token, process.env.SESSION_SECRET);
  } catch {
    res.setHeader('Set-Cookie', 'wf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  // Serve dashboard
  const filePath = path.join(process.cwd(), '_index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
};
