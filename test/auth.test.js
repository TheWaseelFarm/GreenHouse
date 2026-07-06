import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cookie from 'cookie';
import { makeReq, makeRes, invokeStreaming } from './helpers/http.js';

// The login/logout handlers are extensionless CommonJS files; load them
// through a CJS require so Node's resolver picks them up as-is.
const require = createRequire(import.meta.url);

const { requireAuth } = require('../_lib/auth.js');
const loginHandler = require('../_lib/handlers/login');
const logoutHandler = require('../_lib/handlers/logout');
const checkHandler = require('../_lib/handlers/check.js');

const SECRET = 'test-session-secret-xyz';
const USER = 'khaled';
const PASSWORD = 'correct-horse-battery-staple';

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.DASHBOARD_USER = USER;
  process.env.DASHBOARD_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);
});

// Unique client IP per test — the login handler keeps a module-level,
// per-IP rate-limit counter that persists across calls.
let ipCounter = 0;
const freshIp = () => `10.0.0.${++ipCounter}`;
const reqFrom = (extra = {}) =>
  makeReq({ socket: { remoteAddress: freshIp() }, ...extra });

const validToken = (payload = { user: USER }) =>
  jwt.sign(payload, SECRET, { expiresIn: '8h' });

describe('_lib/auth requireAuth', () => {
  it('rejects a request with no cookie (401)', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    expect(requireAuth(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects an invalid/tampered token and clears the cookie (401)', () => {
    const req = makeReq({ headers: { cookie: 'wf_session=not-a-real-jwt' } });
    const res = makeRes();
    expect(requireAuth(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Session expired' });
    expect(res.getHeader('set-cookie')).toContain('wf_session=;');
    expect(res.getHeader('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects a token signed with the wrong secret', () => {
    const bad = jwt.sign({ user: USER }, 'a-different-secret');
    const req = makeReq({ headers: { cookie: `wf_session=${bad}` } });
    const res = makeRes();
    expect(requireAuth(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ user: USER }, SECRET, { expiresIn: -10 });
    const req = makeReq({ headers: { cookie: `wf_session=${expired}` } });
    const res = makeRes();
    expect(requireAuth(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid token and populates req.user', () => {
    const req = makeReq({ headers: { cookie: `wf_session=${validToken()}` } });
    const res = makeRes();
    expect(requireAuth(req, res)).toBe(true);
    expect(res.statusCode).toBe(null); // no error response written
    expect(req.user.user).toBe(USER);
  });
});

describe('api/auth/login', () => {
  it('rejects non-POST methods (405)', async () => {
    const res = await invokeStreaming(loginHandler, reqFrom({ method: 'GET' }), makeRes());
    expect(res.statusCode).toBe(405);
  });

  it('rejects a malformed JSON body (400)', async () => {
    const res = await invokeStreaming(
      loginHandler, reqFrom({ method: 'POST', body: '{not json' }), makeRes());
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });

  it('rejects a body missing username/password (400)', async () => {
    const res = await invokeStreaming(
      loginHandler, reqFrom({ method: 'POST', body: JSON.stringify({ username: USER }) }), makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-string credential types (400)', async () => {
    const res = await invokeStreaming(
      loginHandler,
      reqFrom({ method: 'POST', body: JSON.stringify({ username: 1, password: 2 }) }),
      makeRes());
    expect(res.statusCode).toBe(400);
  });

  it('rejects over-length input without leaking which field (400)', async () => {
    const res = await invokeStreaming(
      loginHandler,
      reqFrom({ method: 'POST', body: JSON.stringify({ username: 'a'.repeat(65), password: 'x' }) }),
      makeRes());
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('returns 500 when auth env vars are not configured', async () => {
    const saved = process.env.DASHBOARD_USER;
    delete process.env.DASHBOARD_USER;
    try {
      const res = await invokeStreaming(
        loginHandler,
        reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD }) }),
        makeRes());
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Server configuration error' });
    } finally {
      process.env.DASHBOARD_USER = saved;
    }
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await invokeStreaming(
      loginHandler,
      reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: 'wrong' }) }),
      makeRes());
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects a wrong username with a generic 401', async () => {
    const res = await invokeStreaming(
      loginHandler,
      reqFrom({ method: 'POST', body: JSON.stringify({ username: 'nobody', password: PASSWORD }) }),
      makeRes());
    expect(res.statusCode).toBe(401);
  });

  it('accepts correct credentials and issues a hardened session cookie', async () => {
    const res = await invokeStreaming(
      loginHandler,
      reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD }) }),
      makeRes());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });

    const setCookie = res.getHeader('set-cookie');
    const parsed = cookie.parse(setCookie);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    // The issued token must verify and carry the username.
    const decoded = jwt.verify(parsed.wf_session, SECRET);
    expect(decoded.user).toBe(USER);
  });

  it('tolerates a stored hash with stray surrounding whitespace/newline', async () => {
    const saved = process.env.DASHBOARD_PASSWORD_HASH;
    process.env.DASHBOARD_PASSWORD_HASH = '  ' + bcrypt.hashSync(PASSWORD, 10) + '\n';
    try {
      const res = await invokeStreaming(
        loginHandler,
        reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD }) }),
        makeRes());
      expect(res.statusCode).toBe(200);
    } finally {
      process.env.DASHBOARD_PASSWORD_HASH = saved;
    }
  });

  it('accepts a plaintext DASHBOARD_PASSWORD when no hash is configured', async () => {
    const savedHash = process.env.DASHBOARD_PASSWORD_HASH;
    delete process.env.DASHBOARD_PASSWORD_HASH;
    process.env.DASHBOARD_PASSWORD = PASSWORD;
    try {
      const ok = await invokeStreaming(
        loginHandler,
        reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: PASSWORD }) }),
        makeRes());
      expect(ok.statusCode).toBe(200);

      const bad = await invokeStreaming(
        loginHandler,
        reqFrom({ method: 'POST', body: JSON.stringify({ username: USER, password: 'nope' }) }),
        makeRes());
      expect(bad.statusCode).toBe(401);
    } finally {
      delete process.env.DASHBOARD_PASSWORD;
      process.env.DASHBOARD_PASSWORD_HASH = savedHash;
    }
  });

  it('rate-limits after 5 failed attempts from the same IP (429)', async () => {
    const ip = { remoteAddress: '203.0.113.99' };
    const attempt = () => invokeStreaming(
      loginHandler,
      makeReq({ method: 'POST', socket: ip, body: JSON.stringify({ username: USER, password: 'wrong' }) }),
      makeRes());

    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.statusCode).toBe(401);
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
  });

  it('reads the client IP from x-forwarded-for for rate limiting', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' };
    const attempt = () => invokeStreaming(
      loginHandler,
      makeReq({ method: 'POST', headers, body: JSON.stringify({ username: USER, password: 'wrong' }) }),
      makeRes());
    for (let i = 0; i < 5; i++) await attempt();
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
  });
});

describe('api/auth/logout', () => {
  it('clears the session cookie and redirects to /login', async () => {
    const res = makeRes();
    await logoutHandler(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(302);
    expect(res.getHeader('location')).toBe('/login');
    expect(res.getHeader('set-cookie')).toContain('wf_session=;');
    expect(res.getHeader('set-cookie')).toMatch(/Max-Age=0/);
    expect(res.ended).toBe(true);
  });
});

describe('api/auth/check', () => {
  it('returns 401 when no session cookie is present', async () => {
    const res = makeRes();
    await checkHandler(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 for a valid session', async () => {
    const res = makeRes();
    await checkHandler(makeReq({ headers: { cookie: `wf_session=${validToken()}` } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 401 and clears the cookie for an invalid session', async () => {
    const res = makeRes();
    await checkHandler(makeReq({ headers: { cookie: 'wf_session=garbage' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.getHeader('set-cookie')).toContain('Max-Age=0');
  });
});
