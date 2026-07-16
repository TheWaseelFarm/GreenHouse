import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes, waitUntilEnded } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const accessRequests = require('../_lib/handlers/access-requests.js');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/auth/access-requests', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await accessRequests(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await accessRequests(makeReq({ method: 'GET', headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-GET methods (405)', async () => {
    const res = makeRes();
    await accessRequests(makeReq({ method: 'POST', headers: authedHeaders() }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns the access requests as JSON', async () => {
    const rows = [{ id: '1', name: 'Ahmed', email: 'a@b.com', status: 'pending' }];
    const scope = nock(SUPA).get('/rest/v1/access_requests').query(true).reply(200, rows);

    const res = makeRes();
    await accessRequests(makeReq({ method: 'GET', headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(rows);
    expect(scope.isDone()).toBe(true);
  });
});
