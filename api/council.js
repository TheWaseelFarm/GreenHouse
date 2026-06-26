const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const host = SUPABASE_URL.replace('https://', '');

  // GET — جلب آخر 10 قرارات
  if (req.method === 'GET') {
    const options = {
      hostname: host,
      path: '/rest/v1/council_decisions?order=created_at.desc&limit=10',
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    };

    const supaReq = https.request(options, (supaRes) => {
      let data = '';
      supaRes.on('data', chunk => data += chunk);
      supaRes.on('end', () => {
        try {
          res.status(200).json(JSON.parse(data));
        } catch(e) {
          res.status(500).json({ error: 'Parse error' });
        }
      });
    });

    supaReq.on('error', e => res.status(500).json({ error: e.message }));
    supaReq.end();
    return;
  }

  // POST — حفظ قرار جديد
  if (req.method === 'POST') {
    const { question, summary, agents_count } = req.body || {};

    if (!question || !summary) {
      return res.status(400).json({ error: 'question and summary are required' });
    }

    const payload = JSON.stringify({
      question,
      summary,
      agents_count: agents_count || 7
    });

    const options = {
      hostname: host,
      path: '/rest/v1/council_decisions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      }
    };

    const supaReq = https.request(options, (supaRes) => {
      res.status(201).json({ success: true, message: 'Decision saved to dashboard' });
    });

    supaReq.on('error', e => res.status(500).json({ error: e.message }));
    supaReq.write(payload);
    supaReq.end();
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
