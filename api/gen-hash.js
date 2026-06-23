// api/gen-hash.js — TEMPORARY — DELETE THIS FILE AFTER USE
const bcrypt = require('bcryptjs');

module.exports = async (req, res) => {
  const setupKey = req.query.k;
  const password = req.query.p;

  if (!setupKey || !password) {
    return res.status(400).json({ error: 'Missing parameters. Use ?p=PASSWORD&k=SETUP_KEY' });
  }

  if (setupKey !== process.env.SETUP_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const hash = await bcrypt.hash(password, 12);

  return res.status(200).json({
    hash,
    instruction: 'Copy the hash value above into DASHBOARD_PASSWORD_HASH in Vercel env vars. Then DELETE this file immediately.'
  });
};
