import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { calcVPD } from '../_lib/metrics.js';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.CRON_SECRET = 'cron-secret';
process.env.ECOWITT_APP_KEY = 'app-key';
process.env.ECOWITT_API_KEY = 'api-key';
process.env.ECOWITT_MAC = '1C:8F:57:37:33:2F';

const require = createRequire(import.meta.url);
const pull = require('../api/ecowitt-pull.js');

const SUPA = 'https://test.supabase.co';
const ECO = 'https://api.ecowitt.net';
const authHeaders = { authorization: 'Bearer cron-secret' };

// A realistic Ecowitt v3 real_time payload (temp already °C via temp_unitid=1).
const m = (v) => ({ time: '1', unit: 'C', value: String(v) });
const PAYLOAD = {
  code: 0, msg: 'success', time: '1700000000',
  data: {
    indoor:  { temperature: m(18), humidity: m(67) },          // gateway box — ignored
    co2_aqi_combo: { co2: m(450) },                            // CO2 only
    t_rh_aqi_combo: { temperature: m(21.7), humidity: m(51) }, // WH46 → greenhouse air
    temp_and_humidity_ch1: { temperature: m(28.7), humidity: m(36) }, // CH1 — IGNORED (location unverified)
    temp_and_humidity_ch2: { temperature: m(30),   humidity: m(19) }, // CH2 → OUTDOOR
    temp_ch1: { temperature: m(21.5) }, // irrigation / working tank
    temp_ch2: { temperature: m(24.3) }, // supply / storage tank
    soil_ch1: { soilmoisture: m(22), ad: m(143) }, // WH51 soil moisture (L4·T20·lv6)
  },
};

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

function mockEcowitt(payload = PAYLOAD) {
  nock(ECO).get('/api/v3/device/real_time').query(true).reply(200, payload);
}
function mockHistory() {
  nock(SUPA).get('/rest/v1/readings').query(true).reply(200, []);
}

describe('api/ecowitt-pull', () => {
  it('rejects without the cron bearer token (401)', async () => {
    const res = makeRes();
    await pull(makeReq({ headers: { authorization: 'Bearer wrong' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('maps WH46 → greenhouse air and CH2 → outdoor, ignoring CH1', async () => {
    mockEcowitt();
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('ecowitt-api');

    // Greenhouse air comes from the WH46 (t_rh_aqi_combo), NOT from CH1 (28.7).
    expect(res.body.temp).toBe(21.7);
    expect(res.body.humidity).toBe(51);
    expect(res.body.co2).toBe(450);
    expect(res.body.vpd).toBe(calcVPD(21.7, 51));
    expect(res.body.air).toEqual({ temp: 21.7, hum: 51, source: 'WH46 (provisional)' });

    // No zone blend — the single interior reading is the greenhouse figure.
    expect(res.body.temp_weighted).toBe(21.7);

    // CH2 is outdoor now; inside-vs-outside delta = 21.7 − 30 = −8.3.
    expect(res.body.outdoor_temp).toBe(30);
    expect(res.body.outdoor.temp).toBe(30);
    expect(res.body.cooling_delta).toBe(-8.3);

    expect(res.body.water_temp_irrigation).toBe(21.5);
    expect(res.body.water_temp_outside).toBe(24.3);
    expect(res.body.soil_moisture).toBe(22);

    // Persisted row: greenhouse air in temperature, outdoor in outdoor_temp,
    // wet-wall/far-end retired to null.
    expect(saved.temperature).toBe(21.7);
    expect(saved.outdoor_temp).toBe(30);
    expect(saved.hub_temp).toBeNull();
    expect(saved.far_end_temp).toBeNull();
    expect(saved.water_temp_irrigation).toBe(21.5);
    expect(saved.soil_moisture).toBe(22);
  });

  it('writes null greenhouse air when the WH46 is absent, but still logs outdoor/water/soil', async () => {
    const p = JSON.parse(JSON.stringify(PAYLOAD));
    delete p.data.t_rh_aqi_combo; // no interior air sensor this cycle
    // CH1 is present but must NOT be used as a fallback.
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.temp).toBeNull();          // CH1 (28.7) is ignored, not a fallback
    expect(saved.temperature).toBeNull();
    expect(saved.vpd).toBeNull();
    expect(saved.cooling_delta).toBeNull();
    // Outdoor / water / soil still logged so the row is not skipped.
    expect(saved.outdoor_temp).toBe(30);
    expect(saved.soil_moisture).toBe(22);
  });

  it('skips the insert when the gateway is offline (indoor-only, no sensor data)', async () => {
    // Gateway offline: API returns only its built-in indoor sensor, no channels.
    const p = { code: 0, msg: 'success', time: '1', data: { indoor: { temperature: m(24), humidity: m(50) } } };
    mockEcowitt(p);
    // No Supabase POST mock — a write here would throw a disallowed-net-connect error.
    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped).toBe('no-sensor-data');
  });

  it('returns 502 when the Ecowitt API reports an error code', async () => {
    nock(ECO).get('/api/v3/device/real_time').query(true).reply(200, { code: 40010, msg: 'Operation too frequent' });
    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe(40010);
  });

  it('returns 500 when the Ecowitt API keys are not configured', async () => {
    const saved = process.env.ECOWITT_APP_KEY;
    delete process.env.ECOWITT_APP_KEY;
    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);
    expect(res.statusCode).toBe(500);
    process.env.ECOWITT_APP_KEY = saved;
  });
});
