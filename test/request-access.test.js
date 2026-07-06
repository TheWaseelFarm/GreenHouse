import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes, invokeStreaming, waitUntilEnded } from './helpers/http.js';

const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';

const require = createRequire(import.meta.url);
const requestAccess = require('../_lib/handlers/request-access.js');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/auth/request-access', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await requestAccess(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects non-POST methods (405)', async () => {
    const res = await invokeStreaming(requestAccess, makeReq({ method: 'GET' }), makeRes());
    expect(res.statusCode).toBe(405);
  });

  it('rejects a malformed JSON body (400)', async () => {
    const res = await invokeStreaming(
      requestAccess, makeReq({ method: 'POST', body: '{not json' }), makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body missing name or email (400)', async () => {
    const res = await invokeStreaming(
      requestAccess, makeReq({ method: 'POST', body: JSON.stringify({ name: 'A' }) }), makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid email (400)', async () => {
    const res = await invokeStreaming(
      requestAccess,
      makeReq({ method: 'POST', body: JSON.stringify({ name: 'Ahmed', email: 'not-an-email' }) }),
      makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('records a valid request as pending and returns 201', async () => {
    let sentBody;
    const scope = nock(SUPA)
      .post('/rest/v1/access_requests', (b) => { sentBody = b; return true; })
      .reply(201, '');

    const res = await invokeStreaming(
      requestAccess,
      makeReq({
        method: 'POST',
        socket: { remoteAddress: '203.0.113.5' },
        body: JSON.stringify({ name: 'Ahmed Ali', email: 'ahmed@example.com', note: 'Farm manager' }),
      }),
      makeRes());
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true });
    expect(sentBody).toEqual({
      name: 'Ahmed Ali',
      email: 'ahmed@example.com',
      note: 'Farm manager',
      status: 'pending',
    });
    expect(scope.isDone()).toBe(true);
  });

  it('rate-limits after 5 requests from the same IP (429)', async () => {
    nock(SUPA).post('/rest/v1/access_requests').times(5).reply(201, '');
    const socket = { remoteAddress: '198.51.100.42' };
    const attempt = () => invokeStreaming(
      requestAccess,
      makeReq({ method: 'POST', socket, body: JSON.stringify({ name: 'Test User', email: 'a@b.com' }) }),
      makeRes());

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      await waitUntilEnded(res);
      expect(res.statusCode).toBe(201);
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
  });
});
