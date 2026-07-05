import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes, invokeStreaming, waitUntilEnded } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const saveReading = require('../_lib/handlers/save-reading.js');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/save-reading', () => {
  it('responds 200 to OPTIONS preflight with CORS headers', async () => {
    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('access-control-allow-origin')).toBe('*');
  });

  it('persists a reading and echoes the upstream status', async () => {
    let sent;
    const scope = nock(SUPA)
      .post('/rest/v1/readings', (b) => { sent = b; return true; })
      .reply(201, '');

    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({
      method: 'POST',
      headers: authedHeaders(),
      body: { co2: 800, temperature: 24.5, humidity: 60, vpd: 1.1 },
    }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, status: 201 });
    expect(sent.co2).toBe(800);
    expect(scope.isDone()).toBe(true);
  });

  it('defaults the water-leak flags to false when absent', async () => {
    let sent;
    nock(SUPA).post('/rest/v1/readings', (b) => { sent = b; return true; }).reply(201, '');

    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({
      method: 'POST',
      headers: authedHeaders(),
      body: { temperature: 22 },
    }), res);
    await waitUntilEnded(res);

    expect(sent.water_leak_1).toBe(false);
    expect(sent.water_leak_2).toBe(false);
  });

  it('preserves explicit water-leak flags', async () => {
    let sent;
    nock(SUPA).post('/rest/v1/readings', (b) => { sent = b; return true; }).reply(201, '');

    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({
      method: 'POST',
      headers: authedHeaders(),
      body: { temperature: 22, water_leak_1: true, water_leak_2: false },
    }), res);
    await waitUntilEnded(res);

    expect(sent.water_leak_1).toBe(true);
  });

  it('returns 500 on a malformed JSON body', async () => {
    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({ method: 'POST', headers: authedHeaders(), body: '{bad json' }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await invokeStreaming(saveReading, makeReq({ method: 'POST', headers: {}, body: { temperature: 22 } }), res);
    expect(res.statusCode).toBe(401);
  });
});
