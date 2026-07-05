import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeReq, makeRes } from './helpers/http.js';

const require = createRequire(import.meta.url);
const { resolveAction } = require('../_lib/dispatch.js');
const authDispatch = require('../api/auth.js');
const sensorsDispatch = require('../api/sensors.js');
const dataDispatch = require('../api/data.js');

describe('_lib/dispatch resolveAction', () => {
  it('reads the action from req.query (Vercel route dest ?_a=...)', () => {
    expect(resolveAction({ url: '/api/auth.js?_a=login', query: { _a: 'login' } })).toBe('login');
  });
  it('falls back to the query string in req.url', () => {
    expect(resolveAction({ url: '/api/auth.js?_a=check' })).toBe('check');
  });
  it('falls back to the last path segment (local/dev)', () => {
    expect(resolveAction({ url: '/api/auth/logout' })).toBe('logout');
  });
});

describe('api dispatchers', () => {
  it('auth dispatcher 404s an unknown action', () => {
    const res = makeRes();
    authDispatch(makeReq({ url: '/api/auth.js?_a=nope', query: { _a: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('sensors dispatcher 404s an unknown action', () => {
    const res = makeRes();
    sensorsDispatch(makeReq({ url: '/api/sensors.js?_a=nope', query: { _a: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('data dispatcher 404s an unknown action', () => {
    const res = makeRes();
    dataDispatch(makeReq({ url: '/api/data.js?_a=nope', query: { _a: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('auth dispatcher routes a known action to its handler (OPTIONS check → 401 without cookie is handled by the handler, not 404)', () => {
    // "check" is a real action; the handler runs (no cookie → 401), proving it
    // dispatched rather than 404ing.
    const res = makeRes();
    authDispatch(makeReq({ url: '/api/auth.js?_a=check', query: { _a: 'check' }, headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });
});
