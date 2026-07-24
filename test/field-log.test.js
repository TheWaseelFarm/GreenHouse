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
const save = require('../_lib/handlers/field-log-save.js');
const list = require('../_lib/handlers/field-log-list.js');

// A tiny valid base64 JPEG payload (content is irrelevant to the handler).
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAg=';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('api/data/field-log-save', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: {}, body: { note: 'hi' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-POST methods (405)', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'GET', headers: authedHeaders() }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects an empty entry (400)', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(), body: { activities: [], note: '' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('saves a note-only entry (no photos)', async () => {
    let inserted;
    nock(SUPA).post('/rest/v1/field_logs', (b) => { inserted = b; return true; })
      .reply(201, [{ id: 'f1', note: 'Aphids on Row A' }]);

    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(),
      body: { log_date: '2026-07-24', location: 'Row A', activities: ['Pest inspection'], note: 'Aphids on Row A' } }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(inserted.activities).toEqual(['Pest inspection']);
    expect(inserted.author).toBe('tester');
    expect(inserted.photo_urls).toEqual([]);
  });

  it('uploads a photo to storage and stores its public URL', async () => {
    let uploadedPath = null;
    nock(SUPA).post(/\/storage\/v1\/object\/plant-photos\/.+/)
      .reply(200, function (uri) { uploadedPath = uri; return { Key: 'ok' }; });
    let inserted;
    nock(SUPA).post('/rest/v1/field_logs', (b) => { inserted = b; return true; })
      .reply(201, [{ id: 'f2' }]);

    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(),
      body: { log_date: '2026-07-24', activities: ['Harvesting'], photos: [PHOTO] } }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(uploadedPath).toMatch(/\/storage\/v1\/object\/plant-photos\/2026\/07\/24\//);
    expect(inserted.photo_urls).toHaveLength(1);
    expect(inserted.photo_urls[0]).toContain('/storage/v1/object/public/plant-photos/');
  });

  it('rejects a photo that fails to decode (400)', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(),
      body: { activities: ['Harvesting'], photos: ['data:image/gif;base64,not-a-supported-type'] } }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('api/data/field-log-list', () => {
  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await list(makeReq({ method: 'GET', headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns the recent journal entries', async () => {
    nock(SUPA).get('/rest/v1/field_logs').query(true)
      .reply(200, [{ id: 'f1', note: 'x', activities: ['Harvesting'], photo_urls: [] }]);

    const res = makeRes();
    await list(makeReq({ method: 'GET', headers: authedHeaders(), query: {} }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe('f1');
  });
});
