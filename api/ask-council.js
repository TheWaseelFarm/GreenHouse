const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { system, messages, isExec } = req.body;

   const expertInstruction = `\n\nSTRICT FORMAT — NO EXCEPTIONS:\nWrite 2 sentences in English only (no label, no bold, no headers).\n---\nاكتب جملتين بالعربية فقط لمحمد المهندس (بدون عناوين، مباشر وواضح).`;

const execInstruction = `\n\nOUTPUT EXACTLY 8 LINES. NO MORE. NO EXCEPTIONS:\n\nSituation: [one sentence]\n[TODAY] [one action]\n[THIS WEEK] [one action]\nRisk: [one sentence]\n---\nالوضع: [جملة واحدة]\n[اليوم] [مهمة واحدة لمحمد]\n[هذا الأسبوع] [مهمة واحدة لمحمد]\nتحذير: [جملة واحدة]`;
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
     max_tokens: isExec ? 200 : 180,
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
