import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const { evaluateCriticals, processAlerts } = require('../_lib/alerts.js');

const SUPA = 'https://test.supabase.co';
const TWILIO = 'https://api.twilio.com';
const SID = 'ACtest';

// Fixed instants (UTC) → known Riyadh (UTC+3) season + day/night.
const SUMMER_DAY = new Date('2026-07-15T09:00:00Z');   // 12:00 Riyadh, Summer day (crit 30)
const SUMMER_NIGHT = new Date('2026-07-15T20:00:00Z'); // 23:00 Riyadh, Summer night (crit 28)
const WINTER_DAY = new Date('2026-01-15T09:00:00Z');   // 12:00 Riyadh, Winter day (frost 4)

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('evaluateCriticals (pure)', () => {
  const base = { temp_weighted: 24, vpd: 0.8, water_temp_irrigation: 22, water_leak_1: false, temp_valid: true };

  it('is quiet when everything is within range', () => {
    expect(evaluateCriticals(base, SUMMER_DAY)).toEqual([]);
  });

  it('flags temperature above the summer day limit (30°C)', () => {
    const r = evaluateCriticals({ ...base, temp_weighted: 31 }, SUMMER_DAY);
    expect(r.map((x) => x.key)).toContain('temp_high');
  });

  it('uses the cooler summer NIGHT limit (28°C)', () => {
    // 29°C is fine by day (<30) but critical at night (>28).
    expect(evaluateCriticals({ ...base, temp_weighted: 29 }, SUMMER_DAY).map((x) => x.key)).not.toContain('temp_high');
    expect(evaluateCriticals({ ...base, temp_weighted: 29 }, SUMMER_NIGHT).map((x) => x.key)).toContain('temp_high');
  });

  it('flags frost in winter', () => {
    const r = evaluateCriticals({ ...base, temp_weighted: 3.5 }, WINTER_DAY);
    expect(r.map((x) => x.key)).toContain('temp_frost');
  });

  it('does NOT evaluate temperature when the reading is invalid (dead meter)', () => {
    const r = evaluateCriticals({ ...base, temp_weighted: 40, temp_valid: false }, SUMMER_DAY);
    expect(r.map((x) => x.key)).not.toContain('temp_high');
  });

  it('flags hot irrigation water, leak, and critically dry VPD', () => {
    const r = evaluateCriticals(
      { ...base, water_temp_irrigation: 27, water_leak_1: true, vpd: 1.6 },
      SUMMER_DAY
    );
    const keys = r.map((x) => x.key);
    expect(keys).toContain('water_hot');
    expect(keys).toContain('leak');
    expect(keys).toContain('vpd_high');
  });

  it('every alert carries both Arabic and English text', () => {
    const r = evaluateCriticals({ ...base, temp_weighted: 31 }, SUMMER_DAY);
    expect(r[0].ar).toBeTruthy();
    expect(r[0].en).toBeTruthy();
  });
});

describe('processAlerts (state machine)', () => {
  const env = {
    TWILIO_ACCOUNT_SID: SID,
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    ALERT_WHATSAPP_TO: 'whatsapp:+966500000000',
    SUPABASE_URL: SUPA,
    SUPABASE_KEY: 'svc-key',
  };
  const crit = [{ key: 'temp_high', value: 31, en: 'hot', ar: 'حار' }];

  it('is a no-op when Twilio is not configured', async () => {
    const r = await processAlerts({ criticals: crit, env: {}, now: SUMMER_DAY });
    expect(r.skipped).toBe('no-twilio-config');
  });

  it('sends once on onset and records the state', async () => {
    nock(SUPA).get('/rest/v1/alert_state').query(true).reply(200, []); // no prior state
    let sentBody;
    nock(TWILIO).post(`/2010-04-01/Accounts/${SID}/Messages.json`, (b) => { sentBody = b; return true; }).reply(201, {});
    let upserted;
    nock(SUPA).post('/rest/v1/alert_state', (b) => { upserted = b; return true; }).query(true).reply(201, '');

    const r = await processAlerts({ criticals: crit, env, now: SUMMER_DAY });
    expect(r.sent).toEqual([{ key: 'temp_high', kind: 'onset' }]);
    expect(upserted.active).toBe(true);
    expect(sentBody.Body).toContain('CRITICAL');
    expect(sentBody.To).toBe('whatsapp:+966500000000');
  });

  it('does NOT resend within the reminder window', async () => {
    const recent = new Date(SUMMER_DAY.getTime() - 10 * 60000).toISOString(); // 10 min ago
    nock(SUPA).get('/rest/v1/alert_state').query(true)
      .reply(200, [{ key: 'temp_high', active: true, last_notified: recent }]);
    // No Twilio mock — a send would throw a disallowed-net-connect error.

    const r = await processAlerts({ criticals: crit, env, now: SUMMER_DAY });
    expect(r.sent).toEqual([]);
  });

  it('resends a reminder after the reminder window (>60 min)', async () => {
    const old = new Date(SUMMER_DAY.getTime() - 61 * 60000).toISOString();
    nock(SUPA).get('/rest/v1/alert_state').query(true)
      .reply(200, [{ key: 'temp_high', active: true, last_notified: old }]);
    nock(TWILIO).post(`/2010-04-01/Accounts/${SID}/Messages.json`).reply(201, {});
    nock(SUPA).post('/rest/v1/alert_state').query(true).reply(201, '');

    const r = await processAlerts({ criticals: crit, env, now: SUMMER_DAY });
    expect(r.sent).toEqual([{ key: 'temp_high', kind: 'reminder' }]);
  });

  it('sends a resolved notice when an active condition clears', async () => {
    nock(SUPA).get('/rest/v1/alert_state').query(true)
      .reply(200, [{ key: 'temp_high', active: true, last_notified: SUMMER_DAY.toISOString() }]);
    let body;
    nock(TWILIO).post(`/2010-04-01/Accounts/${SID}/Messages.json`, (b) => { body = b; return true; }).reply(201, {});
    let upserted;
    nock(SUPA).post('/rest/v1/alert_state', (b) => { upserted = b; return true; }).query(true).reply(201, '');

    const r = await processAlerts({ criticals: [], env, now: SUMMER_DAY }); // nothing critical now
    expect(r.sent).toEqual([{ key: 'temp_high', kind: 'resolved' }]);
    expect(upserted.active).toBe(false);
    expect(body.Body).toContain('RESOLVED');
  });
});
