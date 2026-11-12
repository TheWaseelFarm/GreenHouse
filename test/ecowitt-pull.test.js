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
    indoor:  { temperature: m(23), humidity: m(48) },
    outdoor: { temperature: m(41.3), humidity: m(12) },
    co2_aqi_combo: { co2: m(800), temperature: m(26), humidity: m(58) },
    temp_and_humidity_ch1: { temperature: m(25),   humidity: m(60) }, // canopy
    temp_and_humidity_ch2: { temperature: m(22),   humidity: m(75) }, // wet wall
    temp_and_humidity_ch3: { temperature: m(27.8), humidity: m(63) }, // far end
    temp_and_humidity_ch4: { temperature: m(26),   humidity: m(58) }, // zone 4
    temp_ch1: { temperature: m(26.7) }, // irrigation water
    temp_ch2: { temperature: m(30) },   // outside water
    soil_ch1: { soilmoisture: m(42), ad: m(90) }, // WH51 soil moisture
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

  it('pulls from the Ecowitt API, maps zones, and saves a reading', async () => {
    mockEcowitt();
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('ecowitt-api');
    expect(res.body.temp).toBe(25);
    expect(res.body.humidity).toBe(60);
    expect(res.body.co2).toBe(800);
    expect(res.body.vpd).toBe(calcVPD(25, 60));

    expect(res.body.zones.canopy).toEqual({ temp: 25, hum: 60 });
    expect(res.body.zones.wetwall).toEqual({ temp: 22, hum: 75 });
    expect(res.body.zones.farend.temp).toBe(27.8);
    expect(res.body.zones.zone4.temp).toBe(26);

    // 25*.4 + 22*.3 + 27.8*.15 + 26*.15 = 24.67 → 24.7
    expect(res.body.temp_weighted).toBe(24.7);
    expect(res.body.cooling_delta).toBe(3); // 25 − 22
    expect(res.body.outdoor_temp).toBe(41.3);
    expect(res.body.water_temp_irrigation).toBe(26.7);
    expect(res.body.water_temp_outside).toBe(30);
    expect(res.body.soil_moisture).toBe(42);

    // Persisted row mirrors the existing readings columns.
    expect(saved.temperature).toBe(25);
    expect(saved.hub_temp).toBe(22);
    expect(saved.far_end_temp).toBe(27.8);
    expect(saved.water_temp_irrigation).toBe(26.7);
    expect(saved.soil_moisture).toBe(42);
    expect(saved.tuya_gh_temp).toBeNull();
  });

  it('rejects the disconnected 0/0 canopy without dragging the average', async () => {
    const p = JSON.parse(JSON.stringify(PAYLOAD));
    p.data.temp_and_humidity_ch1 = { temperature: m(0), humidity: m(0) }; // disconnected
    delete p.data.co2_aqi_combo.temperature; // no canopy fallback either
    delete p.data.co2_aqi_combo.humidity;
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.body.zones.canopy.temp).toBeNull();
    // weighted average = the three valid zones (22,27.8,26), never dragged by 0
    expect(res.body.temp_weighted).toBe(24.4); // (22*.3+27.8*.15+26*.15)/.6 ≈ 24.45 → 24.4
    expect(saved.temperature).toBe(0);
  });

  it('uses the WH46 t_rh_aqi_combo for canopy when no WN31 channel is paired', async () => {
    // Real-world state with only the WH46D (USB) paired: CO2 under
    // co2_aqi_combo, its temp/humidity under t_rh_aqi_combo, no WN31 channels.
    const p = {
      code: 0, msg: 'success', time: '1',
      data: {
        indoor: { temperature: m(24.2), humidity: m(66) },
        co2_aqi_combo: { co2: m(677) },
        t_rh_aqi_combo: { temperature: m(24.3), humidity: m(67) },
      },
    };
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.body.co2).toBe(677);
    expect(res.body.temp).toBe(24.3);
    expect(res.body.humidity).toBe(67);
    expect(res.body.zones.canopy.temp).toBe(24.3);
    expect(res.body.temp_weighted).toBe(24.3); // only canopy present
    expect(saved.co2).toBe(677);
    expect(saved.temperature).toBe(24.3);
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
