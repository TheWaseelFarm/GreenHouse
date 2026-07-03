import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

// incidents.js reads SUPABASE_URL/KEY at module load, so set them first.
const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const incidents = require('../api/incidents.js');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/incidents', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await incidents(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });

  it('rejects unsupported methods (405)', async () => {
    const res = makeRes();
    await incidents(makeReq({ method: 'PUT', headers: authedHeaders() }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await incidents(makeReq({ method: 'GET', query: {}, headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  describe('GET', () => {
    it('returns the incident list with the default limit of 50', async () => {
      const rows = [{ id: 1, type: 'heat' }, { id: 2, type: 'leak' }];
      const scope = nock(SUPA)
        .get('/rest/v1/incidents')
        .query({ order: 'started_at.desc', limit: '50' })
        .reply(200, rows);

      const res = makeRes();
      await incidents(makeReq({ method: 'GET', query: {}, headers: authedHeaders() }), res);

      expect(res.body).toEqual(rows);
      expect(scope.isDone()).toBe(true);
    });

    it('honours a custom limit query param', async () => {
      const scope = nock(SUPA)
        .get('/rest/v1/incidents')
        .query({ order: 'started_at.desc', limit: '5' })
        .reply(200, []);

      const res = makeRes();
      await incidents(makeReq({ method: 'GET', query: { limit: 5 }, headers: authedHeaders() }), res);

      expect(res.body).toEqual([]);
      expect(scope.isDone()).toBe(true);
    });

    it('coerces a non-array payload to an empty array', async () => {
      nock(SUPA).get('/rest/v1/incidents').query(true).reply(200, { message: 'oops' });

      const res = makeRes();
      await incidents(makeReq({ method: 'GET', query: {}, headers: authedHeaders() }), res);

      expect(res.body).toEqual([]);
    });

    it('maps an upstream error to a 500', async () => {
      nock(SUPA).get('/rest/v1/incidents').query(true).reply(500, { error: 'boom' });

      const res = makeRes();
      await incidents(makeReq({ method: 'GET', query: {}, headers: authedHeaders() }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST create', () => {
    it('creates an incident and returns the new id', async () => {
      let sentBody;
      const scope = nock(SUPA)
        .post('/rest/v1/incidents', (b) => { sentBody = b; return true; })
        .reply(201, [{ id: 'inc-123' }]);

      const res = makeRes();
      await incidents(makeReq({
        method: 'POST',
        headers: authedHeaders(),
        body: { type: 'heat', severity: 'high', description: 'too hot' },
      }), res);

      expect(res.body).toEqual({ ok: true, id: 'inc-123' });
      expect(sentBody.type).toBe('heat');
      expect(sentBody.resolved).toBe(false);
      expect(scope.isDone()).toBe(true);
    });

    it('defaults optional peak fields to null and stress_score to 0', async () => {
      let sentBody;
      nock(SUPA)
        .post('/rest/v1/incidents', (b) => { sentBody = b; return true; })
        .reply(201, [{ id: 'x' }]);

      const res = makeRes();
      await incidents(makeReq({ method: 'POST', headers: authedHeaders(), body: { type: 'leak' } }), res);

      expect(sentBody.peak_temp).toBeNull();
      expect(sentBody.peak_vpd).toBeNull();
      expect(sentBody.stress_score).toBe(0);
    });

    it('parses a raw JSON string body', async () => {
      let sentBody;
      nock(SUPA)
        .post('/rest/v1/incidents', (b) => { sentBody = b; return true; })
        .reply(201, [{ id: 'y' }]);

      const res = makeRes();
      await incidents(makeReq({ method: 'POST', headers: authedHeaders(), body: JSON.stringify({ type: 'heat' }) }), res);

      expect(sentBody.type).toBe('heat');
    });
  });

  describe('POST resolve', () => {
    it('computes duration_minutes from started_at and marks resolved', async () => {
      const startedAt = new Date(Date.now() - 30 * 60000).toISOString(); // 30 min ago
      nock(SUPA)
        .get('/rest/v1/incidents')
        .query({ id: 'eq.42', select: 'started_at' })
        .reply(200, [{ started_at: startedAt }]);

      let patchBody;
      nock(SUPA)
        .patch('/rest/v1/incidents', (b) => { patchBody = b; return true; })
        .query({ id: 'eq.42' })
        .reply(200, {});

      const res = makeRes();
      await incidents(makeReq({ method: 'POST', headers: authedHeaders(), body: { action: 'resolve', id: 42 } }), res);

      expect(res.body).toEqual({ ok: true });
      expect(patchBody.resolved).toBe(true);
      expect(patchBody.duration_minutes).toBe(30);
      expect(typeof patchBody.ended_at).toBe('string');
    });

    it('tolerates a missing incident row (null duration)', async () => {
      nock(SUPA)
        .get('/rest/v1/incidents')
        .query({ id: 'eq.99', select: 'started_at' })
        .reply(200, []);

      let patchBody;
      nock(SUPA)
        .patch('/rest/v1/incidents', (b) => { patchBody = b; return true; })
        .query({ id: 'eq.99' })
        .reply(200, {});

      const res = makeRes();
      await incidents(makeReq({ method: 'POST', headers: authedHeaders(), body: { action: 'resolve', id: 99 } }), res);

      expect(res.body).toEqual({ ok: true });
      expect(patchBody.duration_minutes).toBeNull();
    });
  });
});
