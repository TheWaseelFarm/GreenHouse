import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes, waitUntilEnded } from './helpers/http.js';

const SUPA = 'https://test.supabase.co';
process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_KEY = 'test-key';

const require = createRequire(import.meta.url);
const council = require('../api/council.js');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/council', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await council(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects unsupported methods (405)', async () => {
    const res = makeRes();
    await council(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  describe('GET', () => {
    it('returns the last decisions as JSON', async () => {
      const rows = [{ id: 1, question: 'q', summary: 's' }];
      const scope = nock(SUPA)
        .get('/rest/v1/council_decisions')
        .query({ order: 'created_at.desc', limit: '20' })
        .reply(200, rows);

      const res = makeRes();
      await council(makeReq({ method: 'GET' }), res);
      await waitUntilEnded(res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(rows);
      expect(scope.isDone()).toBe(true);
    });

    it('returns 500 when the upstream payload is not JSON', async () => {
      nock(SUPA).get('/rest/v1/council_decisions').query(true).reply(200, 'not-json');

      const res = makeRes();
      await council(makeReq({ method: 'GET' }), res);
      await waitUntilEnded(res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'parse error' });
    });
  });

  describe('POST', () => {
    it('rejects a body missing question or summary (400)', async () => {
      const res = makeRes();
      await council(makeReq({ method: 'POST', body: { question: 'q only' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'question and summary required' });
    });

    it('saves a decision and defaults agents_count to 7', async () => {
      let sentBody;
      const scope = nock(SUPA)
        .post('/rest/v1/council_decisions', (b) => { sentBody = b; return true; })
        .reply(201, '');

      const res = makeRes();
      await council(makeReq({
        method: 'POST',
        body: { question: 'Should we vent?', summary: 'Yes, at noon.' },
      }), res);
      await waitUntilEnded(res);

      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ success: true });
      expect(sentBody).toEqual({
        question: 'Should we vent?',
        summary: 'Yes, at noon.',
        agents_count: 7,
      });
      expect(scope.isDone()).toBe(true);
    });

    it('preserves an explicit agents_count', async () => {
      let sentBody;
      nock(SUPA)
        .post('/rest/v1/council_decisions', (b) => { sentBody = b; return true; })
        .reply(201, '');

      const res = makeRes();
      await council(makeReq({
        method: 'POST',
        body: { question: 'q', summary: 's', agents_count: 3 },
      }), res);
      await waitUntilEnded(res);

      expect(sentBody.agents_count).toBe(3);
    });
  });
});
