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

  it('builds the plant_code from the location index and attaches the climate snapshot', async () => {
    let inserted;
    nock(SUPA).post('/rest/v1/field_logs', (b) => { inserted = b; return true; }).reply(201, [{ id: 'm1' }]);

    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(), body: {
      log_type: 'monitoring', log_date: '2026-09-25',
      line: 3, tower: 12, level: 4, outlet: 2,
      growth_stage: 'flowering', vigor: 4, feed_ec: 1.2, feed_ph: 5.8, water_temp: 21,
      climate: { temp: 25.8, humidity: 49, vpd: 1.7, co2: 416, water_temp: 25, recorded_at: '2026-09-25T09:00:00Z', junk: 'x' },
    } }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(inserted.log_type).toBe('monitoring');
    expect(inserted.plant_code).toBe('L3-T12-Lv4-O2');
    expect(inserted.vigor).toBe(4);
    expect(inserted.feed_ec).toBe(1.2);
    expect(inserted.climate.temp).toBe(25.8);
    expect(inserted.climate.junk).toBeUndefined(); // only known keys kept
  });

  it('clamps an out-of-range outlet/vigor to null', async () => {
    let inserted;
    nock(SUPA).post('/rest/v1/field_logs', (b) => { inserted = b; return true; }).reply(201, [{ id: 'm2' }]);

    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(), body: {
      log_type: 'monitoring', line: 1, tower: 2, level: 1, outlet: 9, vigor: 8, note: 'x',
    } }), res);
    await waitUntilEnded(res);

    expect(inserted.outlet).toBeNull();        // only 1..4 valid
    expect(inserted.plant_code).toBe('L1-T2-Lv1'); // outlet dropped, rest kept
    expect(inserted.vigor).toBeNull();         // only 1..5 valid
  });

  it('computes the pre-harvest safety_end date for a treatment entry', async () => {
    let inserted;
    nock(SUPA).post('/rest/v1/field_logs', (b) => { inserted = b; return true; }).reply(201, [{ id: 't1' }]);

    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(), body: {
      log_type: 'treatment', log_date: '2026-09-25', line: 2, tower: 5,
      pesticide: 'Sulfur WG', active_ingredient: 'Sulfur 80%', dose: '2 g/L',
      method: 'spray', pest: 'Powdery mildew', phi_days: 3, operator: 'Mohammed',
    } }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(inserted.log_type).toBe('treatment');
    expect(inserted.pesticide).toBe('Sulfur WG');
    expect(inserted.safety_end).toBe('2026-09-28'); // 25 Sep + 3 days
    expect(inserted.plant_code).toBe('L2-T5');
  });

  it('rejects an empty treatment entry (400)', async () => {
    const res = makeRes();
    await save(makeReq({ method: 'POST', headers: authedHeaders(),
      body: { log_type: 'treatment', line: 1, tower: 1 } }), res);
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
