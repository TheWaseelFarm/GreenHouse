import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { makeReq, makeRes, invokeStreaming, waitUntilEnded } from './helpers/http.js';
import { TEST_SESSION_SECRET } from './helpers/auth.js';

const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.DASHBOARD_USER = 'owner';
process.env.DASHBOARD_PASSWORD_HASH = bcrypt.hashSync('owner-pass', 10);

const require = createRequire(import.meta.url);
const login = require('../_lib/handlers/login.js');
const review = require('../_lib/handlers/review-request.js');
const changePw = require('../_lib/handlers/change-password.js');

const adminCookie = 'wf_session=' + jwt.sign({ user: 'owner', role: 'admin' }, TEST_SESSION_SECRET, { expiresIn: '8h' });
const viewerCookie = (email) => 'wf_session=' + jwt.sign({ user: email, email, role: 'viewer', mustChange: true }, TEST_SESSION_SECRET, { expiresIn: '8h' });

let ip = 0;
const freshIp = () => ({ remoteAddress: `172.16.0.${++ip}` });

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('login — approved users (users table)', () => {
  it('logs in an approved user and flags mustChange', async () => {
    const hash = bcrypt.hashSync('temp-abc', 10);
    nock(SUPA).get('/rest/v1/users').query(true)
      .reply(200, [{ id: 'u1', email: 'x@y.com', username: 'x@y.com', password_hash: hash, role: 'viewer', must_change_password: true, temp_expires_at: null }]);

    const res = await invokeStreaming(login,
      makeReq({ method: 'POST', socket: freshIp(), body: JSON.stringify({ username: 'x@y.com', password: 'temp-abc' }) }), makeRes());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, role: 'viewer', mustChange: true });
  });

  it('rejects an expired temporary password', async () => {
    const hash = bcrypt.hashSync('temp-abc', 10);
    nock(SUPA).get('/rest/v1/users').query(true)
      .reply(200, [{ id: 'u1', email: 'x@y.com', password_hash: hash, role: 'viewer', must_change_password: true, temp_expires_at: '2000-01-01T00:00:00Z' }]);

    const res = await invokeStreaming(login,
      makeReq({ method: 'POST', socket: freshIp(), body: JSON.stringify({ username: 'x@y.com', password: 'temp-abc' }) }), makeRes());

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

describe('review-request (admin approve/deny)', () => {
  it('rejects a non-admin (403)', async () => {
    const res = await invokeStreaming(review,
      makeReq({ method: 'POST', headers: { cookie: viewerCookie('x@y.com') }, body: JSON.stringify({ id: 'R1', action: 'approve' }) }), makeRes());
    expect(res.statusCode).toBe(403);
  });

  it('approves: creates the account and returns a temp password once', async () => {
    nock(SUPA).get('/rest/v1/access_requests').query(true).reply(200, [{ id: 'R1', email: 'x@y.com', name: 'X' }]);
    nock(SUPA).get('/rest/v1/users').query(true).reply(200, []); // no existing user
    let created;
    nock(SUPA).post('/rest/v1/users', (b) => { created = b; return true; }).reply(201, [{ id: 'u1' }]);
    nock(SUPA).patch('/rest/v1/access_requests').query(true).reply(200, [{}]);

    const res = await invokeStreaming(review,
      makeReq({ method: 'POST', headers: { cookie: adminCookie }, body: JSON.stringify({ id: 'R1', action: 'approve' }) }), makeRes());
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.email).toBe('x@y.com');
    expect(typeof res.body.tempPassword).toBe('string');
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(10);
    // The temp password is stored only as a bcrypt hash, never in plaintext.
    expect(created.password_hash).toMatch(/^\$2[aby]\$/);
    expect(created.must_change_password).toBe(true);
    expect(created.password_hash).not.toContain(res.body.tempPassword);
  });

  it('denies a request', async () => {
    nock(SUPA).get('/rest/v1/access_requests').query(true).reply(200, [{ id: 'R2', email: 'z@y.com' }]);
    nock(SUPA).patch('/rest/v1/access_requests').query(true).reply(200, [{}]);

    const res = await invokeStreaming(review,
      makeReq({ method: 'POST', headers: { cookie: adminCookie }, body: JSON.stringify({ id: 'R2', action: 'deny' }) }), makeRes());
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'denied' });
  });
});

describe('change-password', () => {
  it('changes the password when the current one is correct', async () => {
    const hash = bcrypt.hashSync('temp-abc', 10);
    nock(SUPA).get('/rest/v1/users').query(true).reply(200, [{ id: 'u1', email: 'x@y.com', password_hash: hash, role: 'viewer' }]);
    let patched;
    nock(SUPA).patch('/rest/v1/users', (b) => { patched = b; return true; }).query(true).reply(200, [{}]);

    const res = await invokeStreaming(changePw,
      makeReq({ method: 'POST', headers: { cookie: viewerCookie('x@y.com') }, body: JSON.stringify({ currentPassword: 'temp-abc', newPassword: 'brand-new-1' }) }), makeRes());
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(patched.must_change_password).toBe(false);
    expect(patched.password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects an incorrect current password (401)', async () => {
    const hash = bcrypt.hashSync('the-real-one', 10);
    nock(SUPA).get('/rest/v1/users').query(true).reply(200, [{ id: 'u1', email: 'x@y.com', password_hash: hash }]);

    const res = await invokeStreaming(changePw,
      makeReq({ method: 'POST', headers: { cookie: viewerCookie('x@y.com') }, body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'brand-new-1' }) }), makeRes());
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(401);
  });

  it('rejects a too-short new password (400)', async () => {
    const res = await invokeStreaming(changePw,
      makeReq({ method: 'POST', headers: { cookie: viewerCookie('x@y.com') }, body: JSON.stringify({ currentPassword: 'temp-abc', newPassword: 'short' }) }), makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('rejects the env-admin (no DB account) with 400', async () => {
    const res = await invokeStreaming(changePw,
      makeReq({ method: 'POST', headers: { cookie: adminCookie }, body: JSON.stringify({ currentPassword: 'x', newPassword: 'brand-new-1' }) }), makeRes());
    expect(res.statusCode).toBe(400);
  });
});
