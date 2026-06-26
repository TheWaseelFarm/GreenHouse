const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { system, messages, isExec } = req.body;

  const expertInstruction = `
Respond in TWO languages:
ENGLISH (2-3 sentences max, professional, no fluff):
[your point]
---
العربية (ترجمة مختصرة واحترافية لمحمد المهندس):
[الترجمة]`;

  const execInstruction = `
You are briefing a CEO. Be brutally brief.
Format EXACTLY as:
DECISION: [one sentence — what to do]
PRIORITY: [TODAY / THIS WEEK / THIS MONTH]
ACTION FOR MOHAMMED: [one clear task in Arabic for the engineer]
RISK IF IGNORED: [one sentence]
---
القرار: [جملة واحدة]
الأولوية: [اليوم / هذا الأسبوع / هذا الشهر]
مهمة محمد: [مهمة واحدة واضحة]
خطر التأخير: [جملة واحدة]`;

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: system + (isExec ? execInstruction : expertInstruction),
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
