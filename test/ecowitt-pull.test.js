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
    indoor:  { temperature: m(18), humidity: m(70) },          // gateway → BEGINNING / wet wall
    co2_aqi_combo: { co2: m(450) },                            // CO2 only
    t_rh_aqi_combo: { temperature: m(21.7), humidity: m(51) }, // WH46 T/RH — NOT used for air
    temp_and_humidity_ch1: { temperature: m(30),   humidity: m(19) }, // CH1 → OUTDOOR
    temp_and_humidity_ch2: { temperature: m(22),   humidity: m(60) }, // CH2 → MIDDLE
    temp_and_humidity_ch3: { temperature: m(24),   humidity: m(55) }, // CH3 → FAR END
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

  it('maps gateway/CH2/CH3 to the 3 interior points, fair-averages them, CH1 outdoor', async () => {
    mockEcowitt();
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('ecowitt-api');

    // Three interior points: beginning=gateway(18/70), middle=CH2(22/60),
    // far end=CH3(24/55). WH46's own 21.7/51 is NOT used for air.
    expect(res.body.hub_temp).toBe(18);
    expect(res.body.mid_temp).toBe(22);
    expect(res.body.far_end_temp).toBe(24);

    // Headline = fair average: temp (18+22+24)/3 = 21.3; hum (70+60+55)/3 = 62.
    expect(res.body.temp).toBe(21.3);
    expect(res.body.humidity).toBe(62);
    expect(res.body.temp_weighted).toBe(21.3);
    expect(res.body.co2).toBe(450);
    expect(res.body.vpd).toBe(calcVPD(21.3, 62));
    expect(res.body.air).toEqual({ temp: 21.3, hum: 62, source: 'fair avg of 3 interior points' });

    // CH1 is outdoor now; inside-vs-outside delta = 21.3 − 30 = −8.7.
    expect(res.body.outdoor_temp).toBe(30);
    expect(res.body.outdoor.temp).toBe(30);
    expect(res.body.cooling_delta).toBe(-8.7);

    expect(res.body.water_temp_irrigation).toBe(21.5);
    expect(res.body.water_temp_outside).toBe(24.3);
    expect(res.body.soil_moisture).toBe(22);

    // Persisted row carries the average plus all three children and outdoor.
    expect(saved.temperature).toBe(21.3);
    expect(saved.hub_temp).toBe(18);
    expect(saved.mid_temp).toBe(22);
    expect(saved.far_end_temp).toBe(24);
    expect(saved.outdoor_temp).toBe(30);
    expect(saved.water_temp_irrigation).toBe(21.5);
    expect(saved.soil_moisture).toBe(22);
  });

  it('averages only the interior points that reported this cycle', async () => {
    const p = JSON.parse(JSON.stringify(PAYLOAD));
    delete p.data.temp_and_humidity_ch3; // far end missing this cycle
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    // Only beginning(18) + middle(22) → average 20.0; far end null.
    expect(res.body.temp).toBe(20);
    expect(res.body.far_end_temp).toBeNull();
    expect(saved.temperature).toBe(20);
    expect(saved.mid_temp).toBe(22);
  });

  it('writes null greenhouse air when every interior point is absent, but still logs outdoor/water/soil', async () => {
    const p = JSON.parse(JSON.stringify(PAYLOAD));
    delete p.data.indoor;                 // no beginning / wet-wall reading
    delete p.data.temp_and_humidity_ch2;  // no middle
    delete p.data.temp_and_humidity_ch3;  // no far end
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();

    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.temp).toBeNull();
    expect(saved.temperature).toBeNull();
    expect(saved.vpd).toBeNull();
    expect(saved.cooling_delta).toBeNull();
    // Outdoor / water / soil still logged so the row is not skipped.
    expect(saved.outdoor_temp).toBe(30);
    expect(saved.soil_moisture).toBe(22);
  });

  it('logs an indoor-only cycle (the gateway indoor is the wet-wall point now)', async () => {
    // Gateway online but no external channels paired: just its built-in indoor
    // sensor. That IS the beginning/wet-wall reading, so it must be logged.
    const p = { code: 0, msg: 'success', time: '1', data: { indoor: { temperature: m(24), humidity: m(50) } } };
    mockEcowitt(p);
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');
    mockHistory();
    const res = makeRes();
    await pull(makeReq({ headers: authHeaders }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped).toBeUndefined();
    expect(saved.hub_temp).toBe(24);
    expect(saved.temperature).toBe(24); // average of the one interior point present
  });

  it('skips the insert when the gateway returns no mapped sensor data', async () => {
    const p = { code: 0, msg: 'success', time: '1', data: {} };
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
