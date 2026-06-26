const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { system, messages } = req.body;

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system,
    messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const data = await new Promise((resolve, reject) => {
    const apiReq = https.request(options, (apiRes) => {
      let body = '';
      apiRes.on('data', chunk => body += chunk);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Parse error: ' + body)); }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });

  res.status(200).json(data);
};
