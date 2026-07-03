const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { system, messages, isExec, isTech } = req.body;
 
    const expertInstruction = `\n\nاكتب ردك بالعربية فقط. استخدم نقاط واضحة، 3 نقاط بحد أقصى. كل نقطة يجب أن تكون جملة كاملة ومفيدة ولا تنقطع في منتصفها. لا تستخدم عناوين أو تنسيق معقد.`;
 
    const techInstruction = `\n\nاكتب ردك بالعربية فقط. أنت تخاطب خالد صاحب المزرعة وهو من يطور لوحة التحكم بنفسه. اقتراحاتك يجب أن تكون:
- واضحة ومباشرة بدون اختصارات تقنية مبهمة
- كل اقتراح في جملة كاملة تشرح ماذا يفعل وما فائدته للمزرعة
- 3 اقتراحات بحد أقصى
- ابدأ كل اقتراح بـ: "اقتراح تقني:"`;
 
    const execInstruction = `\n\nاكتب ردك بالعربية فقط بهذا التنسيق الحرفي دون أي إضافات:
 
المشكلة:
[جملة واحدة واضحة تصف المشكلة الجوهرية]
 
الحل:
[جملة واحدة واضحة تصف الحل المتفق عليه]
 
نقاط الاتفاق بين الخبراء:
• [نقطة اتفق عليها الجميع]
• [نقطة اتفق عليها الجميع]
• [نقطة اتفق عليها الجميع]
 
مهام محمد:
1. اليوم: [مهمة واحدة محددة وواضحة يقدر محمد ينفذها اليوم]
2. هذا الأسبوع: [مهمة واحدة محددة وواضحة]
3. هذا الشهر: [مهمة واحدة محددة وواضحة]
 
تحذير:
[جملة واحدة عن أهم خطر إذا لم تنفذ هذه المهام]`;
 
    const isTechAgent = req.body.isTech === true;
    const instruction = isExec ? execInstruction : (isTechAgent ? techInstruction : expertInstruction);
 
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: isExec ? 1500 : 900,
      system: system + instruction,
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
 
