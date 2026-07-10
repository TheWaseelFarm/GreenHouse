import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { calcVPD } from '../_lib/metrics.js';

process.env.SWITCHBOT_TOKEN = 'sb-token';
process.env.SWITCHBOT_SECRET = 'sb-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.CRON_SECRET = 'cron-secret';

const require = createRequire(import.meta.url);
const cronSave = require('../api/cron-save.js');

const SWITCHBOT = 'https://api.switch-bot.com';
const SUPA = 'https://test.supabase.co';

// Device ids are hard-coded in the handler.
const METER = 'B0E9FED4881C';
const HUB = 'FDD0AE072D7C';
const WATER = 'E7760186472B';
const OUTDOOR = 'E7764046575F';
const FAR_END = 'E77646060A5C';

const authHeaders = { authorization: 'Bearer cron-secret' };

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

function mockDevice(id, body) {
  return nock(SWITCHBOT)
    .get(`/v1.1/devices/${id}/status`)
    .reply(200, JSON.stringify({ body }));
}

describe('api/cron-save', () => {
  it('rejects a request without the cron bearer token (401)', async () => {
    const res = makeRes();
    await cronSave(makeReq({ headers: { authorization: 'Bearer wrong' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no Authorization header (401)', async () => {
    const res = makeRes();
    await cronSave(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('collects all devices, derives metrics, and saves a reading', async () => {
    mockDevice(METER, { temperature: 25, humidity: 60, CO2: 800 });
    mockDevice(HUB, { temperature: 22, humidity: 75 });
    mockDevice(WATER, { status: 'leak_detected' });
    mockDevice(OUTDOOR, { temperature: 41.3, humidity: 12 });
    mockDevice(FAR_END, { temperature: 27.8, humidity: 63 });

    let saved;
    const supa = nock(SUPA)
      .post('/rest/v1/readings', (b) => { saved = b; return true; })
      .reply(201, '');

    const res = makeRes();
    await cronSave(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.co2).toBe(800);
    expect(res.body.temp).toBe(25);
    expect(res.body.vpd).toBe(calcVPD(25, 60));
    // Weighted averages: 70% canopy + 30% wet wall.
    expect(res.body.temp_weighted).toBe(24.1); // 25*0.7 + 22*0.3
    expect(res.body.cooling_delta).toBe(3);    // 25 - 22
    expect(res.body.water_leak_1).toBe(true);

    // Outdoor + far-end sensors.
    expect(res.body.outdoor_temp).toBe(41.3);
    expect(res.body.outdoor_humidity).toBe(12);
    expect(res.body.far_end_temp).toBe(27.8);
    expect(res.body.far_end_humidity).toBe(63);

    // The persisted payload carries the derived metrics and new columns too.
    expect(saved.plant_stress_index).toBeGreaterThanOrEqual(0);
    expect(saved).toHaveProperty('dew_point');
    expect(saved.outdoor_temp).toBe(41.3);
    expect(saved.outdoor_humidity).toBe(12);
    expect(saved.far_end_temp).toBe(27.8);
    expect(saved.far_end_humidity).toBe(63);
    expect(supa.isDone()).toBe(true);
  });

  it('stores null (not 0) when an outdoor/far-end reading is missing', async () => {
    mockDevice(METER, { temperature: 24, humidity: 55, CO2: 700 });
    mockDevice(HUB, { temperature: 23, humidity: 70 });
    mockDevice(WATER, {});
    mockDevice(OUTDOOR, {});   // sensor offline — no temperature/humidity
    mockDevice(FAR_END, { temperature: 26 });

    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');

    const res = makeRes();
    await cronSave(makeReq({ headers: authHeaders }), res);

    expect(saved.outdoor_temp).toBeNull();
    expect(saved.outdoor_humidity).toBeNull();
    expect(saved.far_end_temp).toBe(26);
    expect(saved.far_end_humidity).toBeNull();
  });

  it('detects a leak via the detectionState field as well', async () => {
    mockDevice(METER, { temperature: 24, humidity: 55, CO2: 700 });
    mockDevice(HUB, { temperature: 23, humidity: 70 });
    mockDevice(WATER, { detectionState: 'detected' });
    mockDevice(OUTDOOR, { temperature: 40, humidity: 15 });
    mockDevice(FAR_END, { temperature: 27, humidity: 60 });
    nock(SUPA).post('/rest/v1/readings').reply(201, '');

    const res = makeRes();
    await cronSave(makeReq({ headers: authHeaders }), res);

    expect(res.body.water_leak_1).toBe(true);
  });

  it('returns 500 when a device fetch fails', async () => {
    nock(SWITCHBOT).get(`/v1.1/devices/${METER}/status`).replyWithError('network down');
    nock(SWITCHBOT).get(`/v1.1/devices/${HUB}/status`).reply(200, JSON.stringify({ body: {} }));
    nock(SWITCHBOT).get(`/v1.1/devices/${WATER}/status`).reply(200, JSON.stringify({ body: {} }));
    nock(SWITCHBOT).get(`/v1.1/devices/${OUTDOOR}/status`).reply(200, JSON.stringify({ body: {} }));
    nock(SWITCHBOT).get(`/v1.1/devices/${FAR_END}/status`).reply(200, JSON.stringify({ body: {} }));

    const res = makeRes();
    await cronSave(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});
