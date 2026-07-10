// Tuya Cloud API client — token management + HMAC-SHA256 request signing.
//
// Credentials come from env vars (never hard-coded in the repo):
//   TUYA_ACCESS_ID     — Access ID / Client ID
//   TUYA_ACCESS_SECRET — Access Secret / Client Secret
//   TUYA_ENDPOINT      — data-center host (default: https://openapi.tuyaeu.com)
//                        US:    https://openapi.tuyaus.com
//                        EU:    https://openapi.tuyaeu.com
//                        China: https://openapi.tuyacn.com
//                        India: https://openapi.tuyain.com
//
// Signature algorithm: https://developer.tuya.com/en/docs/iot/new-singnature
//   sign = HMAC-SHA256(client_id + access_token + t + nonce + stringToSign, secret).toUpperCase()
//   stringToSign = METHOD \n Content-SHA256 \n SignatureHeaders \n URL

const https = require('https');
const crypto = require('crypto');

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function endpoint() {
  return (process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmac(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

// Build Tuya's signature for one request.
function buildSign({ accessId, secret, accessToken, t, nonce, method, path, contentSha256 }) {
  const stringToSign = [method, contentSha256, '', path].join('\n');
  const str = accessId + (accessToken || '') + t + nonce + stringToSign;
  return hmac(str, secret);
}

// Low-level HTTPS request returning parsed JSON.
function request(method, path, headers, body) {
  const url = new URL(endpoint() + path);
  const payload = body ? JSON.stringify(body) : '';
  const outHeaders = { 'Content-Type': 'application/json', ...headers };
  if (payload) outHeaders['Content-Length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers: outHeaders },
      resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error('Tuya returned non-JSON: ' + text.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// In-memory token cache (per warm serverless instance).
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60000) return tokenCache.token;

  const accessId = process.env.TUYA_ACCESS_ID;
  const secret = process.env.TUYA_ACCESS_SECRET;
  if (!accessId || !secret) throw new Error('TUYA_ACCESS_ID / TUYA_ACCESS_SECRET not configured');

  const t = now.toString();
  const nonce = '';
  const path = '/v1.0/token?grant_type=1';
  const sign = buildSign({
    accessId, secret, accessToken: '', t, nonce,
    method: 'GET', path, contentSha256: EMPTY_BODY_SHA256,
  });

  const res = await request('GET', path, {
    client_id: accessId, sign, t, sign_method: 'HMAC-SHA256', nonce,
  });
  if (!res.success) throw new Error('Tuya token error: ' + (res.msg || JSON.stringify(res)));

  tokenCache = { token: res.result.access_token, expiresAt: now + (res.result.expire_time * 1000) };
  return tokenCache.token;
}

// Signed business request (auto-manages the access token).
async function api(method, path, body) {
  const accessId = process.env.TUYA_ACCESS_ID;
  const secret = process.env.TUYA_ACCESS_SECRET;
  const token = await getToken();
  const t = Date.now().toString();
  const nonce = '';
  const contentSha256 = body ? sha256(JSON.stringify(body)) : EMPTY_BODY_SHA256;
  const sign = buildSign({ accessId, secret, accessToken: token, t, nonce, method, path, contentSha256 });
  return request(method, path, {
    client_id: accessId, access_token: token, sign, t, sign_method: 'HMAC-SHA256', nonce,
  }, body);
}

module.exports = {
  getToken,
  api,
  // Exposed for tests.
  _internal: { buildSign, sha256, EMPTY_BODY_SHA256, resetTokenCache: () => { tokenCache = { token: null, expiresAt: 0 }; } },
};
