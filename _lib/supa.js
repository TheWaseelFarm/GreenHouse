// Tiny Supabase REST (PostgREST) helper. Server-side only — uses the service
// key, which bypasses RLS. Never expose this to the browser.
const https = require('https');

function request(method, path, body) {
  const host = (process.env.SUPABASE_URL || '').replace('https://', '');
  const key = process.env.SUPABASE_KEY || '';
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
    const req = https.request({ hostname: host, path, method, headers }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
        resolve({ status: resp.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Upload raw bytes to a Supabase Storage bucket. Server-side only (service
// key). Returns { status, json, text }; on success the object is reachable at
// <SUPABASE_URL>/storage/v1/object/public/<bucket>/<objectPath> when the
// bucket is public.
function upload(bucket, objectPath, buffer, contentType) {
  const host = (process.env.SUPABASE_URL || '').replace('https://', '');
  const key = process.env.SUPABASE_KEY || '';
  const path = '/storage/v1/object/' + bucket + '/' + objectPath;
  return new Promise((resolve, reject) => {
    const headers = {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': buffer.length,
      'x-upsert': 'true',
    };
    const req = https.request({ hostname: host, path, method: 'POST', headers }, resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
        resolve({ status: resp.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// Public URL for an object in a public bucket.
function publicUrl(bucket, objectPath) {
  return (process.env.SUPABASE_URL || '') + '/storage/v1/object/public/' + bucket + '/' + objectPath;
}

// Read a JSON body off the request stream (UTF-8). Handlers behind the auth
// dispatcher don't get a pre-parsed body.
function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
  });
}

module.exports = {
  supaGet: (p) => request('GET', p, null),
  supaPost: (p, b) => request('POST', p, b),
  supaPatch: (p, b) => request('PATCH', p, b),
  supaUpload: upload,
  supaPublicUrl: publicUrl,
  readJson,
};
