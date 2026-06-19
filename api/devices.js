const https = require('https');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const TOKEN = process.env.SWITCHBOT_TOKEN;
  const SECRET = process.env.SWITCHBOT_SECRET;
  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const sign = crypto.createHmac('sha256', SECRET)
    .update(TOKEN + timestamp + nonce).digest('base64');

  const options = {
    hostname: 'api.switch-bot.com',
    path: '/v1.1/devices',
    method: 'GET',
    headers: {
      'Authorization': TOKEN,
      'sign': sign,
      'nonce': nonce,
      't': timestamp,
      'Content-Type': 'application/json'
    }
  };

  const data = await new Promise((resolve, reject) => {
    const request = https.get(options, (response) => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });

  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(data);
};
