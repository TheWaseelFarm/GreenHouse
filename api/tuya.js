// Consolidated Tuya function. Routes /api/tuya/* to one Serverless Function.
//   /api/tuya/devices        → list devices linked to the cloud project
//   /api/tuya/status?id=...   → read a device's data points (status)
//   /api/tuya/command?id=...  → POST { commands:[{code,value}] } to control a device
const { resolveAction } = require('../_lib/dispatch');
const { api } = require('../_lib/tuya');
const { requireAuth } = require('../_lib/auth');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  await new Promise(resolve => { req.on('data', c => chunks.push(c)); req.on('end', resolve); });
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// GET /api/tuya/devices — every device linked to the project's app account.
async function devices(req, res) {
  const r = await api('GET', '/v1.0/iot-01/associated-users/devices');
  if (!r.success) return res.status(502).json({ error: r.msg || 'Tuya error', code: r.code });
  const list = (r.result?.devices || []).map(d => ({
    id: d.id,
    name: d.name,
    product_name: d.product_name,
    category: d.category,
    online: d.online,
  }));
  return res.status(200).json({ count: list.length, devices: list });
}

// GET /api/tuya/status?id=DEVICE_ID — the device's data points.
async function status(req, res) {
  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'device id required (?id=...)' });
  const r = await api('GET', `/v1.0/devices/${encodeURIComponent(id)}/status`);
  if (!r.success) return res.status(502).json({ error: r.msg || 'Tuya error', code: r.code });
  return res.status(200).json({ id, status: r.result });
}

// POST /api/tuya/command?id=DEVICE_ID  body: { commands:[{code,value}] }
async function command(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query?.id;
  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  const commands = body.commands;
  if (!id || !Array.isArray(commands) || commands.length === 0) {
    return res.status(400).json({ error: 'id and a non-empty commands[] are required' });
  }
  const r = await api('POST', `/v1.0/devices/${encodeURIComponent(id)}/commands`, { commands });
  if (!r.success) return res.status(502).json({ error: r.msg || 'Tuya error', code: r.code });
  return res.status(200).json({ success: true, result: r.result });
}

const handlers = { devices, status, command };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const handler = handlers[resolveAction(req)];
  if (!handler) return res.status(404).json({ error: 'Not found' });
  try {
    return await handler(req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
