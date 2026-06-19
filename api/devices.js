const crypto = require('crypto');
const axios = require('axios');

module.exports = async (req, res) => {
  const TOKEN = process.env.SWITCHBOT_TOKEN;
  const SECRET = process.env.SWITCHBOT_SECRET;
  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const sign = crypto.createHmac('sha256', SECRET)
    .update(TOKEN + timestamp + nonce).digest('base64');
  try {
    const r = await axios.get('https://api.switch-bot.com/v1.1/devices', {
      headers: { 'Authorization': TOKEN, 'sign': sign, 'nonce': nonce, 't': timestamp }
    });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
};
