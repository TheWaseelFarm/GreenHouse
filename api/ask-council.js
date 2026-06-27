
const https = require('https');
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const { system, messages, isExec } = req.body;
 
    const expertInstruction = `\n\nاكتب ردك بالعربية فقط. استخدم نقاط واضحة، 3 نقاط بحد أقصى، بدون عناوين. اجعل كل نقطة جملة كاملة ومفيدة. لا تقطع الكلام في منتصف الجملة.`;
 
    const execInstruction = `\n\nاكتب ردك بالعربية فقط بهذا التنسيق الحرفي:
 
الوضع الحالي:
[جملة واحدة تلخص وضع المزرعة الآن]
 
نقاط الاتفاق بين الخبراء:
• [نقطة اتفق عليها الجميع]
• [نقطة اتفق عليها الجميع]
• [نقطة اتفق عليها الجميع]
 
الخطوات المطلوبة من محمد:
[اليوم] [مهمة واحدة محددة وواضحة]
[هذا الأسبوع] [مهمة واحدة محددة وواضحة]
[هذا الشهر] [مهمة واحدة محددة وواضحة]
 
تحذير:
[جملة واحدة عن أهم خطر إذا لم تُنفذ الخطوات]`;
 
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: isExec ? 1200 : 800,
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
 
