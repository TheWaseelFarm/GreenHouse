import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { calcVPD } from '../_lib/metrics.js';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.INGEST_SECRET = 'ingest-secret';

const require = createRequire(import.meta.url);
const ingest = require('../api/ingest.js');

const SUPA = 'https://test.supabase.co';
const okQuery = { key: 'ingest-secret' };

// °C → °F for building Ecowitt-style test payloads.
const c2f = (c) => (c * 9) / 5 + 32;

beforeAll(() => nock.disableNetConnect());
afterAll(() => { nock.enableNetConnect(); delete process.env.ECOWITT_PASSKEYS; });
afterEach(() => { nock.cleanAll(); delete process.env.ECOWITT_PASSKEYS; });

describe('api/ingest (Ecowitt push)', () => {
  it('rejects a request without the shared key (401)', async () => {
    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: { key: 'wrong' }, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects when no key is present (401)', async () => {
    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: {}, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('parses an Ecowitt payload, converts °F→°C, maps zones, and saves', async () => {
    const body = {
      PASSKEY: 'ABC123', stationtype: 'GW2000A_V3.1.0', model: 'GW2000',
      temp1f: c2f(25).toFixed(1), humidity1: '60',  // canopy
      temp2f: c2f(22).toFixed(1), humidity2: '75',  // wet wall
      temp3f: c2f(27.8).toFixed(1), humidity3: '63', // far end
      temp4f: c2f(26).toFixed(1), humidity4: '58',  // zone 4
      co2: '800',
      tempf: c2f(41.3).toFixed(1), humidity: '12',  // outdoor
      tf_ch1: c2f(26.7).toFixed(1),                 // irrigation water
      tf_ch2: c2f(30).toFixed(1),                   // outside water
    };

    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');

    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.source).toBe('ecowitt');
    expect(res.body.co2).toBe(800);
    expect(res.body.temp).toBe(25);
    expect(res.body.humidity).toBe(60);
    expect(res.body.vpd).toBe(calcVPD(25, 60));

    // Zones round-tripped.
    expect(res.body.zones.canopy).toEqual({ temp: 25, hum: 60 });
    expect(res.body.zones.wetwall).toEqual({ temp: 22, hum: 75 });
    expect(res.body.zones.farend.temp).toBe(27.8);
    expect(res.body.zones.zone4.temp).toBe(26);

    // Weighted average over all four zones (weights 0.40/0.30/0.15/0.15).
    expect(res.body.temp_weighted).toBe(24.7); // 25*.4+22*.3+27.8*.15+26*.15 = 24.67
    expect(res.body.cooling_delta).toBe(3);    // canopy 25 − wet wall 22

    expect(res.body.outdoor_temp).toBe(41.3);
    expect(res.body.outdoor_humidity).toBe(12);
    expect(res.body.water_temp_irrigation).toBe(26.7);
    expect(res.body.water_temp_outside).toBe(30);

    // Persisted row carries the mapped columns.
    expect(saved.temperature).toBe(25);
    expect(saved.hub_temp).toBe(22);
    expect(saved.far_end_temp).toBe(27.8);
    expect(saved.water_temp_irrigation).toBe(26.7);
    expect(saved.tuya_gh_temp).toBeNull();
  });

  it('accepts a raw urlencoded body string (as the gateway sends it)', async () => {
    const raw = `PASSKEY=XYZ&model=GW2000&temp1f=${c2f(24).toFixed(1)}&humidity1=55&co2=700`;
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');

    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body: raw }), res);

    expect(res.statusCode).toBe(200);
    expect(saved.temperature).toBe(24);
    expect(res.body.co2).toBe(700);
  });

  it('rejects a disconnected 0/0 canopy probe without dragging the average', async () => {
    const body = {
      temp1f: '32', humidity1: '0',       // 0°C / 0% → disconnected, rejected
      temp2f: c2f(24).toFixed(1), humidity2: '58',
    };
    let saved;
    nock(SUPA).post('/rest/v1/readings', (b) => { saved = b; return true; }).reply(201, '');

    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body }), res);

    expect(res.body.zones.canopy.temp).toBeNull();
    // Only the wet-wall zone is valid, so the weighted average is that value —
    // never 0 dragged in from the dead canopy probe.
    expect(res.body.temp_weighted).toBe(24);
    expect(saved.temperature).toBe(0); // canopy column stores 0 (no reading)
  });

  it('flags a leak from a WH55 leak channel', async () => {
    const body = { temp1f: c2f(24).toFixed(1), humidity1: '55', leak_ch1: '1' };
    nock(SUPA).post('/rest/v1/readings').reply(201, '');
    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body }), res);
    expect(res.body.water_leak_1).toBe(true);
  });

  it('rejects an unknown gateway when a PASSKEY allowlist is set (401)', async () => {
    process.env.ECOWITT_PASSKEYS = 'KNOWN1,KNOWN2';
    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body: { PASSKEY: 'STRANGER', temp1f: '70' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('accepts a gateway whose PASSKEY is on the allowlist', async () => {
    process.env.ECOWITT_PASSKEYS = 'KNOWN1,KNOWN2';
    nock(SUPA).post('/rest/v1/readings').reply(201, '');
    const res = makeRes();
    await ingest(makeReq({ method: 'POST', query: okQuery, body: { PASSKEY: 'KNOWN2', temp1f: c2f(23).toFixed(1), humidity1: '50' } }), res);
    expect(res.statusCode).toBe(200);
  });
});
