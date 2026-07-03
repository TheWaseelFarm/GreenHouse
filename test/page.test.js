import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';
import { makeReq, makeRes } from './helpers/http.js';

const require = createRequire(import.meta.url);
const page = require('../api/page.js');

const SECRET = 'test-session-secret';
beforeAll(() => { process.env.SESSION_SECRET = SECRET; });

describe('api/page (auth gate)', () => {
  it('serves the login page without a session', async () => {
    const res = makeRes();
    await page(makeReq({ url: '/login' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toBe('text/html');
    expect(typeof res.body).toBe('string');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('redirects to /login when no session cookie is present', async () => {
    const res = makeRes();
    await page(makeReq({ url: '/', headers: {} }), res);
    expect(res.statusCode).toBe(302);
    expect(res.getHeader('location')).toBe('/login');
    expect(res.ended).toBe(true);
  });

  it('redirects and clears the cookie for an invalid session', async () => {
    const res = makeRes();
    await page(makeReq({ url: '/', headers: { cookie: 'wf_session=bogus' } }), res);
    expect(res.statusCode).toBe(302);
    expect(res.getHeader('location')).toBe('/login');
    expect(res.getHeader('set-cookie')).toContain('Max-Age=0');
  });

  it('redirects an expired token to /login', async () => {
    const expired = jwt.sign({ user: 'x' }, SECRET, { expiresIn: -5 });
    const res = makeRes();
    await page(makeReq({ url: '/', headers: { cookie: `wf_session=${expired}` } }), res);
    expect(res.statusCode).toBe(302);
    expect(res.getHeader('location')).toBe('/login');
  });
});
