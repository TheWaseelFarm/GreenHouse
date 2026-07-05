import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

// Env consumed by the SwitchBot handlers (HMAC signing) and Supabase history.
process.env.SWITCHBOT_TOKEN = 'sb-token';
process.env.SWITCHBOT_SECRET = 'sb-secret';
const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const devices = require('../_lib/handlers/devices.js');
const status = require('../_lib/handlers/status.js');
const history = require('../_lib/handlers/history.js');

const SWITCHBOT = 'https://api.switch-bot.com';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('auth gate', () => {
  it('rejects unauthenticated requests to each read handler (401)', async () => {
    for (const [handler, req] of [
      [devices, makeReq({ method: 'GET', headers: {} })],
      [status, makeReq({ method: 'GET', query: { id: 'X' }, headers: {} })],
      [history, makeReq({ method: 'GET', query: {}, headers: {} })],
    ]) {
      const res = makeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('api/devices', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await devices(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('signs the request and passes the device list through', async () => {
    const payload = JSON.stringify({ body: { deviceList: [{ deviceId: 'A1' }] } });
    let seenHeaders;
    const scope = nock(SWITCHBOT)
      .get('/v1.1/devices')
      .reply(function () { seenHeaders = this.req.headers; return [200, payload]; });

    const res = makeRes();
    await devices(makeReq({ method: 'GET', headers: authedHeaders() }), res);

    expect(res.body).toBe(payload);
    expect(scope.isDone()).toBe(true);
    // Auth material the SwitchBot API requires.
    expect(seenHeaders.authorization).toBeDefined();
    expect(seenHeaders.sign).toBeDefined();
    expect(seenHeaders.nonce).toBeDefined();
    expect(seenHeaders.t).toBeDefined();
  });
});

describe('api/status', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await status(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('requests the status of the device id from the query string', async () => {
    const payload = JSON.stringify({ body: { temperature: 24 } });
    const scope = nock(SWITCHBOT)
      .get('/v1.1/devices/METER123/status')
      .reply(200, payload);

    const res = makeRes();
    await status(makeReq({ method: 'GET', query: { id: 'METER123' }, headers: authedHeaders() }), res);

    expect(res.body).toBe(payload);
    expect(scope.isDone()).toBe(true);
  });
});

describe('api/history', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await history(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('queries readings and passes the payload through with defaults', async () => {
    const rows = JSON.stringify([{ recorded_at: 't', temperature: 24 }]);
    let path;
    const scope = nock(SUPA)
      .get('/rest/v1/readings')
      .query(true)
      .reply(function (uri) { path = uri; return [200, rows]; });

    const res = makeRes();
    await history(makeReq({ method: 'GET', query: {}, headers: authedHeaders() }), res);

    expect(res.body).toBe(rows);
    expect(scope.isDone()).toBe(true);
    // Default window (24h) and row cap (500) appear in the query.
    expect(path).toContain('limit=500');
    expect(path).toContain('order=recorded_at.desc');
  });

  it('honours custom hours and limit query params', async () => {
    let path;
    nock(SUPA)
      .get('/rest/v1/readings')
      .query(true)
      .reply(function (uri) { path = uri; return [200, '[]']; });

    const res = makeRes();
    await history(makeReq({ method: 'GET', query: { hours: 6, limit: 10 }, headers: authedHeaders() }), res);

    expect(path).toContain('limit=10');
  });
});
