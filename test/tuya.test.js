import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes, waitUntilEnded } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

const TUYA = 'https://openapi.tuyatest.com';
process.env.TUYA_ENDPOINT = TUYA;
process.env.TUYA_ACCESS_ID = 'test-access-id';
process.env.TUYA_ACCESS_SECRET = 'test-access-secret';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const tuyaClient = require('../_lib/tuya.js');
const tuyaDispatch = require('../api/tuya.js');

const TOKEN = 'tuya-access-token';

function mockToken() {
  return nock(TUYA)
    .get('/v1.0/token')
    .query({ grant_type: '1' })
    .reply(200, { success: true, result: { access_token: TOKEN, expire_time: 7200 }, t: 1 });
}

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
beforeEach(() => tuyaClient._internal.resetTokenCache());
afterEach(() => nock.cleanAll());

describe('_lib/tuya signing', () => {
  it('produces an uppercase hex HMAC-SHA256 signature', () => {
    const sign = tuyaClient._internal.buildSign({
      accessId: 'id', secret: 'secret', accessToken: '', t: '1700000000000', nonce: '',
      method: 'GET', path: '/v1.0/token?grant_type=1',
      contentSha256: tuyaClient._internal.EMPTY_BODY_SHA256,
    });
    expect(sign).toMatch(/^[0-9A-F]{64}$/);
  });

  it('fetches and caches an access token, signing the request', async () => {
    let headers;
    nock(TUYA).get('/v1.0/token').query({ grant_type: '1' })
      .reply(function () { headers = this.req.headers; return [200, { success: true, result: { access_token: TOKEN, expire_time: 7200 }, t: 1 }]; });

    const tok = await tuyaClient.getToken();
    expect(tok).toBe(TOKEN);
    expect(headers.client_id).toBe('test-access-id');
    expect(headers.sign).toMatch(/^[0-9A-F]{64}$/);
    expect(headers.sign_method).toBe('HMAC-SHA256');
    expect(headers.t).toBeDefined();

    // Second call is served from cache — no second token request mocked.
    const again = await tuyaClient.getToken();
    expect(again).toBe(TOKEN);
  });
});

describe('api/tuya dispatcher', () => {
  it('rejects an unauthenticated request (401)', async () => {
    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=devices', query: { _a: 'devices' }, headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('404s an unknown action', async () => {
    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=nope', query: { _a: 'nope' }, headers: authedHeaders() }), res);
    expect(res.statusCode).toBe(404);
  });

  it('lists devices linked to the project', async () => {
    mockToken();
    nock(TUYA).get('/v1.0/iot-01/associated-users/devices').reply(200, {
      success: true,
      result: { devices: [
        { id: 'dev1', name: 'Greenhouse Fan', product_name: 'Smart Switch', category: 'kg', online: true, extra: 'x' },
        { id: 'dev2', name: 'Soil Sensor', product_name: 'Soil', category: 'zwjcy', online: false },
      ] },
    });

    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=devices', query: { _a: 'devices' }, headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.devices[0]).toEqual({ id: 'dev1', name: 'Greenhouse Fan', product_name: 'Smart Switch', category: 'kg', online: true });
  });

  it('reads a device status by id', async () => {
    mockToken();
    nock(TUYA).get('/v1.0/devices/dev1/status').reply(200, {
      success: true,
      result: [{ code: 'temp_current', value: 268 }, { code: 'humidity_value', value: 55 }],
    });

    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=status&id=dev1', query: { _a: 'status', id: 'dev1' }, headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('dev1');
    expect(res.body.status).toEqual([{ code: 'temp_current', value: 268 }, { code: 'humidity_value', value: 55 }]);
  });

  it('requires an id for status (400)', async () => {
    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=status', query: { _a: 'status' }, headers: authedHeaders() }), res);
    expect(res.statusCode).toBe(400);
  });

  it('surfaces a Tuya API failure as 502', async () => {
    mockToken();
    nock(TUYA).get('/v1.0/iot-01/associated-users/devices').reply(200, { success: false, msg: 'permission deny', code: 1106 });

    const res = makeRes();
    await tuyaDispatch(makeReq({ method: 'GET', url: '/api/tuya.js?_a=devices', query: { _a: 'devices' }, headers: authedHeaders() }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe('permission deny');
    expect(res.body.code).toBe(1106);
  });

  it('sends a control command', async () => {
    mockToken();
    let sentBody;
    nock(TUYA).post('/v1.0/devices/dev1/commands', (b) => { sentBody = b; return true; })
      .reply(200, { success: true, result: true });

    const res = makeRes();
    await tuyaDispatch(makeReq({
      method: 'POST',
      url: '/api/tuya.js?_a=command&id=dev1',
      query: { _a: 'command', id: 'dev1' },
      headers: authedHeaders(),
      body: { commands: [{ code: 'switch_1', value: true }] },
    }), res);
    await waitUntilEnded(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, result: true });
    expect(sentBody).toEqual({ commands: [{ code: 'switch_1', value: true }] });
  });

  it('rejects a command without commands[] (400)', async () => {
    const res = makeRes();
    await tuyaDispatch(makeReq({
      method: 'POST', url: '/api/tuya.js?_a=command&id=dev1', query: { _a: 'command', id: 'dev1' },
      headers: authedHeaders(), body: {},
    }), res);
    expect(res.statusCode).toBe(400);
  });
});
