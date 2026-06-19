const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const TOKEN = process.env.SWITCHBOT_TOKEN;
const SECRET = process.env.SWITCHBOT_SECRET;

function getHeaders() {
  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const sign = crypto.createHmac('sha256', SECRET)
    .update(TOKEN + timestamp + nonce).digest('base64');
  return {
    'Authorization': TOKEN,
    'sign': sign,
    'nonce': nonce,
    't': timestamp,
    'Content-Type': 'application/json'
  };
}

app.get('/api/devices', async (req, res) => {
  try {
    const r = await axios.get('https://api.switch-bot.com/v1.1/devices', { headers: getHeaders() });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const r = await axios.get(`https://api.switch-bot.com/v1.1/devices/${req.params.id}/status`, { headers: getHeaders() });
    res.json(r.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
