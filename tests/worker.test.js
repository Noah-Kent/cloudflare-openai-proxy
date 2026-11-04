import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { handleRequest } from '../src/worker.js';

// Only a Node test adapter; runtime.test.js exercises the real Workers primitive.
crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = 'test-proxy-token-0123456789abcdef0123456789';
const env = { PROXY_TOKEN: token };
const auth = { 'X-Proxy-Token': token, Authorization: 'Bearer test-openai-key', 'Content-Type': 'application/json' };
function req(path = '/v1/responses', options = {}) {
  return new Request('https://proxy.example' + path, {
    method: 'POST', body: '{ "input": "你好" }', ...options,
    headers: options.headers ?? auth,
  });
}
const forbidden = () => { throw new Error('Upstream must not be invoked'); };

for (const [name, headers, bindings, status] of [
  ['missing proxy', { Authorization: auth.Authorization }, env, 403],
  ['wrong proxy', { ...auth, 'X-Proxy-Token': 'wrong-token-0123456789abcdef0123456789' }, env, 403],
  ['empty secret', auth, {}, 403],
  ['short secret fails closed', auth, { PROXY_TOKEN: 'short' }, 403],
  ['missing OpenAI key', { 'X-Proxy-Token': token }, env, 401],
  ['invalid OpenAI format', { ...auth, Authorization: 'Basic abc' }, env, 401],
  ['duplicate proxy', { ...auth, 'X-Proxy-Token': token + ', ' + token }, env, 403],
  ['duplicate authorization', { ...auth, Authorization: 'Bearer a, Bearer b' }, env, 401],
]) test(name, async () => {
  let calls = 0;
  const res = await handleRequest(req(undefined, { headers }), bindings, () => { calls++; return forbidden(); });
  assert.equal(res.status, status); assert.equal(calls, 0);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
  test(`unauthenticated ${method} cannot bypass authentication`, async () => {
    assert.equal((await handleRequest(req('/v1/models', { method, body: undefined, headers: {} }), env, forbidden)).status, 403);
  });
}
for (const path of ['/', '/v1/files', '//evil.example/v1/responses', '/v1/responses/../files',
  '/v1/%72esponses', '/v1/responses%2fanything', '/v1/responses/', '/https://evil.example',
  '/v1/responses/resp_1%2F..%2Fmodels']) {
  test(`reject path ${path}`, async () => {
    let calls = 0;
    assert.equal((await handleRequest(req(path), env, () => { calls++; return forbidden(); })).status, 404);
    assert.equal(calls, 0);
  });
}
test('authenticated OPTIONS and WebSocket are refused without CORS', async () => {
  for (const options of [{ method: 'OPTIONS', body: undefined }, { headers: { ...auth, Upgrade: 'websocket' } }]) {
    const res = await handleRequest(req(undefined, options), env, forbidden);
    assert.ok([400, 405].includes(res.status));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
});

test('fixed HTTPS origin; raw query, raw body and necessary headers preserved; credentials stripped', async () => {
  const headers = { ...auth, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example',
    'X-Proxy-Target': 'https://evil.example', Cookie: 'private=cookie', 'Proxy-Authorization': 'Basic private',
    'X-Api-Key': 'other-secret', 'X-Unknown': 'private', Connection: 'keep-alive, x-client-request-id',
    'X-Client-Request-Id': 'hop-only', 'OpenAI-Project': 'proj_test', 'OpenAI-Organization': 'org_test',
    'OpenAI-Beta': 'test', 'X-Stainless-Lang': 'js', 'Content-Length': '99' };
  let calls = 0;
  const body = '{ "input": "你好", "tools": [{"type":"function","name":"foo"}] }\n';
  const res = await handleRequest(req('/v1/responses?url=https%3A%2F%2Fevil.example&a=1&a=2', { headers, body }), env, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses?url=https%3A%2F%2Fevil.example&a=1&a=2');
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(await new Response(init.body).text(), body);
    assert.equal(init.headers.get('authorization'), auth.Authorization);
    assert.equal(init.headers.get('openai-project'), 'proj_test');
    assert.equal(init.headers.get('x-stainless-lang'), 'js');
    for (const h of ['x-proxy-token', 'host', 'cookie', 'proxy-authorization', 'content-length', 'connection', 'x-api-key', 'x-forwarded-host', 'x-client-request-id', 'x-unknown']) assert.equal(init.headers.get(h), null, h);
    return new Response('raw upstream', { status: 201, headers: {
      'x-request-id': 'req_1', 'retry-after': '5', 'x-ratelimit-remaining-requests': '8',
      'access-control-allow-origin': '*', 'set-cookie': 'private', 'x-proxy-token': 'private',
      connection: 'x-hop', 'x-hop': 'private', 'cache-control': 'public',
    } });
  });
  assert.equal(calls, 1); assert.equal(res.status, 201); assert.equal(await res.text(), 'raw upstream');
  assert.equal(res.headers.get('x-request-id'), 'req_1'); assert.equal(res.headers.get('retry-after'), '5');
  for (const h of ['access-control-allow-origin', 'set-cookie', 'x-proxy-token', 'connection', 'x-hop']) assert.equal(res.headers.get(h), null);
});

for (const path of ['/v1/responses', '/v1/chat/completions']) {
  for (const body of ['{ "input":"test", "stream":false }\n', '{bad JSON',
    JSON.stringify({ tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }], text: { format: { type: 'json_schema', name: 'value', schema: { type: 'object' } } }})]) {
    test(`body transparency ${path} ${body.slice(0, 20)}`, async () => {
      const res = await handleRequest(req(path, { body }), env, async (_, init) => new Response(await new Response(init.body).arrayBuffer()));
      assert.equal(await res.text(), body);
    });
  }
  test(`incremental SSE byte and event integrity ${path}`, async () => {
    const bytes = new TextEncoder().encode(': ping\r\nevent: response.created\r\ndata: {"type":"response.created"}\r\n\r\nevent: response.output_text.delta\ndata: {"delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
    let controller;
    const upstream = new ReadableStream({ start(c) { controller = c; } });
    const res = await handleRequest(req(path), env, async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }));
    const reader = res.body.getReader();
    controller.enqueue(bytes.slice(0, 7));
    assert.deepEqual((await reader.read()).value, bytes.slice(0, 7));
    // Stream stays open after the first event; split even inside UTF-8 characters.
    const rest = [];
    const consume = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; rest.push(...r.value); } })();
    for (let i = 7; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close(); await consume;
    assert.deepEqual(Uint8Array.from(rest), bytes.slice(7));
  });
}

test('multipart and binary bytes are not parsed or reserialized', async () => {
  const body = new Uint8Array([45, 45, 120, 13, 10, 0, 255, 128]);
  const res = await handleRequest(req(undefined, { body, headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=x' } }), env, async (_, init) => {
    assert.equal(init.headers.get('content-type'), 'multipart/form-data; boundary=x');
    return new Response(init.body);
  });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), body);
});
for (const status of [400, 401, 403, 404, 429, 500, 503]) test(`upstream ${status} including non-JSON errors`, async () => {
  const res = await handleRequest(req(), env, async () => new Response('opaque upstream error', { status, headers: { 'retry-after': '2' } }));
  assert.equal(res.status, status); assert.equal(await res.text(), 'opaque upstream error');
  assert.equal(res.headers.get('retry-after'), '2');
});
test('reject upstream redirects rather than redirecting credentials', async () => {
  let cancelled = false;
  const res = await handleRequest(req(), env, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { location: 'https://evil.example' } }));
  assert.equal(res.status, 502); assert.equal(res.headers.get('location'), null); assert.equal(cancelled, true);
});
test('GET models and response lifecycle preserve methods without injecting body', async () => {
  for (const [path, method] of [['/v1/models', 'GET'], ['/v1/models/test-model', 'GET'], ['/v1/responses/resp_123', 'GET'], ['/v1/responses/resp_123', 'DELETE'], ['/v1/responses/resp_123/input_items?limit=1', 'GET'], ['/v1/responses/resp_123/cancel', 'POST']]) {
    const res = await handleRequest(req(path, { method, body: undefined }), env, async (_, init) => {
      assert.equal(init.method, method); assert.ok(init.body == null); return new Response(null, { status: 204 });
    });
    assert.equal(res.status, 204);
  }
});
test('request abort signal reaches upstream', async () => {
  const controller = new AbortController();
  const pending = handleRequest(req(undefined, { signal: controller.signal }), env, async (_, init) => {
    controller.abort(); assert.equal(init.signal.aborted, true); throw new DOMException('aborted', 'AbortError');
  });
  assert.equal((await pending).status, 499);
});
test('response cancellation propagates and streaming failures stay failures', async () => {
  let cancelled = false;
  let res = await handleRequest(req(), env, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await res.body.cancel(); assert.equal(cancelled, true);
  res = await handleRequest(req(), env, async () => new Response(new ReadableStream({ start(c) { c.error(new Error('stream failed')); } })));
  await assert.rejects(res.text(), /stream failed/);
});
test('delayed stream remains incremental (local timing simulation)', async () => {
  let c;
  const res = await handleRequest(req(), env, async () => new Response(new ReadableStream({ start(controller) { c = controller; } })));
  const reader = res.body.getReader(); c.enqueue(new Uint8Array([1]));
  assert.equal((await reader.read()).value[0], 1);
  await delay(100); c.enqueue(new Uint8Array([2])); c.close();
  assert.equal((await reader.read()).value[0], 2); assert.equal((await reader.read()).done, true);
});
test('simple concurrency isolates credentials and bodies', async () => {
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const body = `request-${i}`;
    const res = await handleRequest(req(undefined, { body, headers: { ...auth, Authorization: `Bearer key-${i}` } }), env, async (_, init) => {
      assert.equal(init.headers.get('authorization'), `Bearer key-${i}`); return new Response(init.body);
    });
    assert.equal(await res.text(), body);
  }));
});
test('no sensitive request/exception logs; transport failure is sanitized', async () => {
  const messages = []; const originals = {};
  for (const key of ['log', 'warn', 'error', 'info', 'debug']) { originals[key] = console[key]; console[key] = (...args) => messages.push(args); }
  try {
    const res = await handleRequest(req(), env, async () => { throw new Error(token + ' ' + auth.Authorization); });
    assert.equal(res.status, 502); const text = await res.text();
    assert.ok(!text.includes(token) && !text.includes(auth.Authorization)); assert.deepEqual(messages, []);
  } finally { Object.assign(console, originals); }
});

for (const client of ['Cherry Studio extraHeaders', 'DeepSeek Harness provider.headers']) {
  test(`${client}: independent credentials for discovery and both inference routes`, async () => {
    for (const path of ['/v1/models', '/v1/responses', '/v1/chat/completions']) {
      const method = path.endsWith('/models') ? 'GET' : 'POST';
      const res = await handleRequest(req(path, { method, body: method === 'GET' ? undefined : '{"model":"mock"}',
        headers: { Authorization: 'Bearer client-openai-key', 'X-Proxy-Token': token, 'X-Api-Key': 'client-openai-key' },
      }), env, async (_, init) => {
        assert.equal(init.headers.get('authorization'), 'Bearer client-openai-key');
        assert.equal(init.headers.get('x-proxy-token'), null);
        assert.equal(init.headers.get('x-api-key'), null);
        return Response.json({ ok: true });
      });
      assert.equal(res.status, 200);
    }
  });
}
// Node Response injection verifies byte copying only; compression.test.js checks workerd HTTP encoding.
test('injected binary responses preserve bytes without reserialization', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const encoded = gzipSync('data: {"delta":"你好"}\n\n');
  const res = await handleRequest(req(), env, async () => new Response(encoded, { headers: { 'content-encoding': 'gzip' } }));
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  const actual = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(actual, encoded); assert.equal(gunzipSync(actual).toString(), 'data: {"delta":"你好"}\n\n');
});
