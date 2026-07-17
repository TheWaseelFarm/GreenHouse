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

  it('returns the requests enriched with account state', async () => {
    nock(SUPA).get('/rest/v1/access_requests').query(true)
      .reply(200, [{ id: '1', name: 'Ahmed', email: 'a@b.com', status: 'pending' }]);
    nock(SUPA).get('/rest/v1/users').query(true).reply(200, []);

    const res = makeRes();
    await accessRequests(makeReq({ method: 'GET', headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([{ id: '1', name: 'Ahmed', email: 'a@b.com', status: 'pending', account: null, temp_password: null }]);
  });

  it('surfaces the temp password for an approved account still awaiting first login', async () => {
    nock(SUPA).get('/rest/v1/access_requests').query(true)
      .reply(200, [{ id: '2', name: 'Sara', email: 'sara@b.com', status: 'approved' }]);
    nock(SUPA).get('/rest/v1/users').query(true)
      .reply(200, [{ email: 'sara@b.com', temp_password: 'Kp7mNqRxtz#4', must_change_password: true, temp_expires_at: '2999-01-01T00:00:00Z' }]);

    const res = makeRes();
    await accessRequests(makeReq({ method: 'GET', headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.body[0].account).toBe('awaiting-first-login');
    expect(res.body[0].temp_password).toBe('Kp7mNqRxtz#4');
  });

  it('hides the temp password once the user has set their own', async () => {
    nock(SUPA).get('/rest/v1/access_requests').query(true)
      .reply(200, [{ id: '3', name: 'Omar', email: 'omar@b.com', status: 'approved' }]);
    nock(SUPA).get('/rest/v1/users').query(true)
      .reply(200, [{ email: 'omar@b.com', temp_password: null, must_change_password: false, temp_expires_at: null }]);

    const res = makeRes();
    await accessRequests(makeReq({ method: 'GET', headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.body[0].account).toBe('active');
    expect(res.body[0].temp_password).toBeNull();
  });
});
