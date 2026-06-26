const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { system, messages, isExec } = req.body;

    const expertInstruction = `\n\nSTRICT FORMAT:\nEN: [max 2 sentences, direct, no headers]\n---\nع: [جملتان بالعربية لمحمد المهندس]`;

  const execInstruction = `\n\nFORMAT EXACTLY AS FOLLOWS — TWO SECTIONS:\n\nSECTION 1 - FOR KHALID (English, max 4 lines):\nSituation: [one sentence]\n[TODAY] [action]\n[THIS WEEK] [action]\nRisk: [one sentence]\n---\nالقسم الثاني - لمحمد المهندس (عربي فقط، واضح ومباشر):\nالوضع: [جملة واحدة تشرح المشكلة]\n[اليوم] [مهمة محددة وقابلة للتنفيذ فوراً]\n[هذا الأسبوع] [مهمة محددة]\nتحذير: [جملة واحدة — ماذا يحدث إذا لم تتصرف]`;
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
          catch(e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });

    res.status(200).json(data);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
