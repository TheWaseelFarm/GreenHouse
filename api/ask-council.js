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
      model: 'claude-sonnet-5',
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
        const chunks = [];
        apiRes.on('data', chunk => chunks.push(chunk));
        apiRes.on('end', () => {
          // Decode the full buffer once as UTF-8. Concatenating string
          // conversions of individual chunks corrupts multi-byte (e.g. Arabic)
          // characters that straddle a chunk boundary.
          const body = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(body)); }
          catch(e) { reject(new Error('Parse error: ' + body.substring(0, 200))); }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });
 
    // Normalize the reply: keep only text blocks in `content`. Newer models
    // can prepend a thinking block (with a base64 signature), which would push
    // the answer text out of content[0] and leak the thinking payload to the
    // client. Stripping it here keeps content[0].text the answer for any client.
    if (data && Array.isArray(data.content)) {
      const textOnly = data.content.filter(b => b && b.type === 'text');
      if (textOnly.length) data.content = textOnly;
    }

    res.status(200).json(data);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
 
