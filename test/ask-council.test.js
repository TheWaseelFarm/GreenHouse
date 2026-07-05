import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import nock from 'nock';
import { makeReq, makeRes } from './helpers/http.js';
import { authedHeaders, TEST_SESSION_SECRET } from './helpers/auth.js';

process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

const require = createRequire(import.meta.url);
const askCouncil = require('../api/ask-council.js');

const ANTHROPIC = 'https://api.anthropic.com';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

const baseBody = { system: 'You are an expert.', messages: [{ role: 'user', content: 'hi' }] };

describe('api/ask-council', () => {
  it('responds 200 to OPTIONS preflight', async () => {
    const res = makeRes();
    await askCouncil(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects non-POST methods (405)', async () => {
    const res = makeRes();
    await askCouncil(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects an unauthenticated POST (401)', async () => {
    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: {}, body: baseBody }), res);
    expect(res.statusCode).toBe(401);
  });

  it('forwards the Anthropic response on success', async () => {
    const reply = { content: [{ type: 'text', text: 'مرحبا' }] };
    let sent;
    const scope = nock(ANTHROPIC)
      .post('/v1/messages', (b) => { sent = b; return true; })
      .reply(200, reply);

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: baseBody }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(reply);
    expect(scope.isDone()).toBe(true);
    // System prompt is the caller's system + an appended instruction.
    expect(sent.system.startsWith(baseBody.system)).toBe(true);
    expect(sent.system.length).toBeGreaterThan(baseBody.system.length);
    expect(sent.messages).toEqual(baseBody.messages);
  });

  it('strips a leading thinking block, keeping only the text', async () => {
    const reply = {
      model: 'claude-sonnet-5',
      content: [
        { type: 'thinking', thinking: 'reasoning...', signature: 'AKXsig==' },
        { type: 'text', text: '• اقتراح تقني' },
      ],
    };
    nock(ANTHROPIC).post('/v1/messages').reply(200, reply);

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: baseBody }), res);

    expect(res.statusCode).toBe(200);
    // The thinking block (and its signature) is gone; content[0] is the answer.
    expect(res.body.content).toEqual([{ type: 'text', text: '• اقتراح تقني' }]);
  });

  it('uses the executive format and a larger token budget when isExec', async () => {
    let sent;
    nock(ANTHROPIC).post('/v1/messages', (b) => { sent = b; return true; }).reply(200, {});

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: { ...baseBody, isExec: true } }), res);

    expect(sent.max_tokens).toBe(3000);
    expect(sent.system).toContain('مهام محمد'); // exec-only heading
  });

  it('uses the technical instruction when isTech (and not isExec)', async () => {
    let sent;
    nock(ANTHROPIC).post('/v1/messages', (b) => { sent = b; return true; }).reply(200, {});

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: { ...baseBody, isTech: true } }), res);

    expect(sent.max_tokens).toBe(2000);
    expect(sent.system).toContain('اقتراح تقني'); // tech-only marker
  });

  it('defaults to the expert instruction and 2000 tokens', async () => {
    let sent;
    nock(ANTHROPIC).post('/v1/messages', (b) => { sent = b; return true; }).reply(200, {});

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: baseBody }), res);

    expect(sent.max_tokens).toBe(2000);
    expect(sent.system).not.toContain('مهام محمد');
    expect(sent.system).not.toContain('اقتراح تقني');
  });

  it('returns 500 when the upstream body is not valid JSON', async () => {
    nock(ANTHROPIC).post('/v1/messages').reply(200, 'garbled<<');

    const res = makeRes();
    await askCouncil(makeReq({ method: 'POST', headers: authedHeaders(), body: baseBody }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});
