// _lib/alerts.js — Al-Waseel Farm critical-alert engine (server side).
//
// Runs inside the scheduled cron (api/cron-save.js) so alerts fire even when
// nobody has the dashboard open. Two parts:
//   1. evaluateCriticals() — PURE. Mirrors the dashboard's seasonal day/night
//      quality bands and returns the list of conditions that are critical NOW.
//   2. processAlerts() — I/O. A per-condition state machine backed by the
//      Supabase `alert_state` table + Twilio WhatsApp:
//        • onset      → notify once
//        • sustained  → remind every ALERT_REMINDER_MIN minutes (default 60)
//        • resolved   → one "back to normal" notice, then silence
//      so Mohammed gets a high-signal channel, never a flood.
//
// Twilio credentials are optional: if they're not set, processAlerts() is a
// no-op, so the cron keeps logging normally until the env vars are added.

const https = require('https');

// ── Seasonal quality bands (server mirror of index.html, kept in sync) ──────
// Only the fields the critical checks need: the `crit` danger line and frost.
const TEMP_SEASONS = [
  { name: 'Winter',        ar: 'الشتاء',        months: [12, 1, 2],     day: { crit: 26 }, night: { crit: 21 }, frost: 4 },
  { name: 'Spring/Autumn', ar: 'الربيع/الخريف', months: [3, 4, 10, 11], day: { crit: 29 }, night: { crit: 22 }, frost: 3 },
  { name: 'Summer',        ar: 'الصيف',         months: [5, 6, 7, 8, 9], day: { crit: 30 }, night: { crit: 28 }, frost: null },
];
// VPD upper hard limit (kPa) — above this the air is critically dry.
const VPD_HARD = { day: 1.3, night: 1.1 };
// Irrigation water reaching the roots — above this is root-damage territory.
const WATER_CRIT = 26;

function riyadhParts(date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date || new Date());
  const g = (t) => (p.find((x) => x.type === t) || { value: '0' }).value;
  return { month: +g('month'), hour: +g('hour') % 24, minute: +g('minute') };
}

function isDay(date) {
  const r = riyadhParts(date);
  const h = r.hour + r.minute / 60;
  const m = r.month;
  let start = 6, end = 19;
  if ([12, 1, 2].includes(m)) { start = 7; end = 17; }
  else if ([5, 6, 7, 8, 9].includes(m)) { start = 6; end = 20; }
  else { start = 6.5; end = 18.5; }
  return h >= start && h < end;
}

function seasonBand(date) {
  const { month } = riyadhParts(date);
  const s = TEMP_SEASONS.find((x) => x.months.includes(month)) || TEMP_SEASONS[0];
  const day = isDay(date);
  return { name: s.name, ar: s.ar, isDay: day, crit: (day ? s.day : s.night).crit, frost: s.frost };
}

function fmtTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date || new Date());
}

// ── Pure evaluation ─────────────────────────────────────────────────────────
// m: { temp_weighted, vpd, water_temp_irrigation, water_leak_1, temp_valid }
// Returns [{ key, value, en, ar }] for every condition that is critical now.
// temp_valid guards against a failed canopy meter reading 0°C being mistaken
// for real frost — temperature checks only run when the reading is plausible.
function evaluateCriticals(m, date) {
  const B = seasonBand(date);
  const per = B.isDay ? 'day' : 'night';
  const perAr = B.isDay ? 'نهاراً' : 'ليلاً';
  const out = [];
  const tw = m.temp_weighted;

  if (m.temp_valid && tw != null) {
    if (B.frost != null && tw <= B.frost) {
      out.push({
        key: 'temp_frost', value: tw,
        en: `Greenhouse temperature ${tw.toFixed(1)}°C — FROST RISK. Protect the crop immediately.`,
        ar: `حرارة البيت ${tw.toFixed(1)}°م — خطر صقيع. احمِ المحصول فوراً.`,
      });
    } else if (tw > B.crit) {
      out.push({
        key: 'temp_high', value: tw,
        en: `Greenhouse temperature ${tw.toFixed(1)}°C — above the ${B.name} ${per} limit ${B.crit}°C. Fruit quality at risk. Increase cooling / shade now.`,
        ar: `حرارة البيت ${tw.toFixed(1)}°م — فوق حد ${B.ar} (${perAr}) ${B.crit}°م. جودة الثمار في خطر. زد التبريد/التظليل الآن.`,
      });
    }
  }

  if (m.water_temp_irrigation != null && m.water_temp_irrigation > WATER_CRIT) {
    const w = m.water_temp_irrigation;
    out.push({
      key: 'water_hot', value: w,
      en: `Irrigation water ${w.toFixed(1)}°C — above ${WATER_CRIT}°C at the roots. Root-damage risk. Cool or exchange the irrigation water.`,
      ar: `ماء الري ${w.toFixed(1)}°م — فوق ${WATER_CRIT}°م عند الجذور. خطر تلف الجذور. برّد أو استبدل ماء الري.`,
    });
  }

  if (m.water_leak_1) {
    out.push({
      key: 'leak', value: 1,
      en: 'Water leak detected — inspect the tank and irrigation lines immediately.',
      ar: 'تم كشف تسرب مياه — افحص الخزان وخطوط الري فوراً.',
    });
  }

  if (m.temp_valid && m.vpd != null) {
    const hard = B.isDay ? VPD_HARD.day : VPD_HARD.night;
    if (m.vpd > hard) {
      out.push({
        key: 'vpd_high', value: m.vpd,
        en: `VPD ${m.vpd.toFixed(2)} kPa — critically dry (above ${hard} kPa ${per}). Stomata closing, fruit quality at risk. Raise humidity / activate misting.`,
        ar: `عجز ضغط البخار ${m.vpd.toFixed(2)} kPa — جفاف حرج (فوق ${hard} ${perAr}). الثغور تنغلق وجودة الثمار في خطر. ارفع الرطوبة أو شغّل الرذاذ.`,
      });
    }
  }

  return out;
}

// ── WhatsApp (Twilio) ───────────────────────────────────────────────────────
function twilioConfig(env) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WHATSAPP_FROM;   // e.g. whatsapp:+14155238886
  const to = env.ALERT_WHATSAPP_TO;        // e.g. whatsapp:+9665XXXXXXXX
  if (!sid || !token || !from || !to) return null;
  return { sid, token, from, to };
}

function sendWhatsApp(cfg, body) {
  const form = new URLSearchParams({ From: cfg.from, To: cfg.to, Body: body }).toString();
  const auth = Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
  return httpRequest('api.twilio.com', `/2010-04-01/Accounts/${cfg.sid}/Messages.json`, 'POST', {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }, form);
}

// ── Supabase alert_state persistence ────────────────────────────────────────
function supaHeaders(key) {
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function loadState(supaHost, key) {
  const raw = await httpRequest(supaHost, '/rest/v1/alert_state?select=key,active,last_notified', 'GET', supaHeaders(key));
  let rows = [];
  try { rows = JSON.parse(raw) || []; } catch (_) { rows = []; }
  const byKey = {};
  for (const r of rows) byKey[r.key] = r;
  return byKey;
}

function upsertState(supaHost, key, row) {
  return httpRequest(
    supaHost,
    '/rest/v1/alert_state?on_conflict=key',
    'POST',
    { ...supaHeaders(key), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    JSON.stringify(row)
  );
}

const HEADER_AR = '🔴 مزرعة الوصيل — تنبيه حرج';
const HEADER_EN = 'Al-Waseel Farm — CRITICAL';

function composeMessage(kind, item, now) {
  const time = fmtTime(now);
  if (kind === 'resolved') {
    return `✅ مزرعة الوصيل — عاد إلى الطبيعي\n${item.ar}\n${time} (الرياض)\n—\nAl-Waseel Farm — RESOLVED\n${item.en}\n${time} Riyadh`;
  }
  const tagAr = kind === 'reminder' ? '🔁 لا يزال قائماً' : HEADER_AR;
  const tagEn = kind === 'reminder' ? 'STILL ACTIVE' : HEADER_EN;
  return `${tagAr}\n${item.ar}\n${time} (الرياض)\n—\n${tagEn}\n${item.en}\n${time} Riyadh`;
}

// Resolved copy per condition (short, no live value needed).
const RESOLVED = {
  temp_high:  { en: 'Greenhouse temperature back within the seasonal target.', ar: 'عادت حرارة البيت إلى النطاق الموسمي.' },
  temp_frost: { en: 'Frost risk cleared — temperature back to a safe range.',   ar: 'زال خطر الصقيع — عادت الحرارة لنطاق آمن.' },
  water_hot:  { en: 'Irrigation water back below the root-safe limit.',          ar: 'عاد ماء الري تحت الحد الآمن للجذور.' },
  leak:       { en: 'Water leak sensor clear — no leak detected.',               ar: 'حساس التسرب سليم — لا يوجد تسرب.' },
  vpd_high:   { en: 'VPD back within the operational range.',                     ar: 'عاد عجز ضغط البخار إلى النطاق التشغيلي.' },
};

// ── State machine ───────────────────────────────────────────────────────────
// criticals: output of evaluateCriticals(). env: process.env. now: Date.
// Returns a small summary object (also handy for tests / the cron response).
async function processAlerts({ criticals, env, now }) {
  const cfg = twilioConfig(env);
  if (!cfg) return { skipped: 'no-twilio-config' };
  const supaHost = (env.SUPABASE_URL || '').replace('https://', '');
  const supaKey = env.SUPABASE_KEY;
  if (!supaHost || !supaKey) return { skipped: 'no-supabase' };

  const reminderMs = (parseInt(env.ALERT_REMINDER_MIN, 10) || 60) * 60000;
  const nowDate = now || new Date();
  const nowIso = nowDate.toISOString();

  const state = await loadState(supaHost, supaKey);
  const activeNow = {};
  for (const c of criticals) activeNow[c.key] = c;

  const sent = [];

  // Onset + hourly reminders for conditions that are critical now.
  for (const c of criticals) {
    const st = state[c.key];
    const isActive = st && st.active;
    let kind = null;
    if (!isActive) kind = 'onset';
    else if (nowDate.getTime() - Date.parse(st.last_notified) >= reminderMs) kind = 'reminder';
    if (kind) {
      await sendWhatsApp(cfg, composeMessage(kind, c, nowDate));
      await upsertState(supaHost, supaKey, { key: c.key, active: true, last_notified: nowIso });
      sent.push({ key: c.key, kind });
    }
  }

  // Recovery notice for conditions that were active but have cleared.
  for (const key of Object.keys(state)) {
    if (state[key].active && !activeNow[key]) {
      const item = RESOLVED[key] || { en: `${key} back to normal.`, ar: `${key} عاد إلى الطبيعي.` };
      await sendWhatsApp(cfg, composeMessage('resolved', item, nowDate));
      await upsertState(supaHost, supaKey, { key, active: false, last_notified: nowIso });
      sent.push({ key, kind: 'resolved' });
    }
  }

  return { sent };
}

// ── Minimal HTTPS helper (nock-interceptable, like api/cron-save.js) ─────────
function httpRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers: { ...headers } };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (ch) => chunks.push(ch));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = {
  evaluateCriticals,
  processAlerts,
  // exported for tests
  _internal: { seasonBand, isDay, riyadhParts, composeMessage },
};
