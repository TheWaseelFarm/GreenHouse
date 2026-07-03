// Minimal fakes for the Node/Vercel (req, res) pair used by the handlers.
import { EventEmitter } from 'node:events';

// Build a request. When `body` is provided the request behaves like a
// readable stream (handlers that call req.on('data')/req.on('end') work).
export function makeReq({
  method = 'GET',
  headers = {},
  query = {},
  url = '/',
  body,
  socket = { remoteAddress: '127.0.0.1' },
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.query = query;
  req.url = url;
  req.socket = socket;
  if (body !== undefined) {
    // Vercel-style parsed body when it's an object; raw-stream otherwise.
    if (typeof body === 'object') req.body = body;
    req._raw = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return req;
}

// Capturing response double. Records status, headers, and payload.
export function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; this.ended = true; return this; },
    send(data) { this.body = data; this.ended = true; return this; },
    end(data) { if (data !== undefined) this.body = data; this.ended = true; return this; },
    writeHead(code, hdrs) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
      return this;
    },
  };
  return res;
}

// Drive a handler that reads its body off the request stream. Emits the
// raw body on the next tick, after the handler has attached its listeners.
export async function invokeStreaming(handler, req, res) {
  const done = handler(req, res);
  await new Promise((resolve) => {
    process.nextTick(() => {
      if (req._raw !== undefined) req.emit('data', Buffer.from(req._raw));
      req.emit('end');
      resolve();
    });
  });
  await done;
  return res;
}
