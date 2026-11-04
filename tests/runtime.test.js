import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// All outbound requests are caught by this service; never a real OpenAI call.
test('workerd: native token comparison, request filtering, SSE, models and errors', async () => {
  const token = 'runtime-test-token-0123456789abcdef0123456789';
  const seen = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', compatibilityDate: '2026-11-04',
    compatibilityFlags: ['enable_request_signal'], bindings: { PROXY_TOKEN: token },
    outboundService: async request => {
      seen.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.text() });
      const content = request.url.endsWith('/models') ? '{"data":[]}' : 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
      return new Response(content, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_mock' } });
    },
  }));
  try {
    const headers = { 'X-Proxy-Token': token, Authorization: 'Bearer fake-api-key' };
    const denied = await mf.dispatchFetch('https://proxy.example/v1/models');
    assert.equal(denied.status, 403); assert.equal(seen.length, 0);
    const res = await mf.dispatchFetch('https://proxy.example/v1/responses', { method: 'POST', headers, body: '{"stream":true}' });
    assert.equal(res.status, 200); assert.match(await res.text(), /response.completed/);
    assert.equal(res.headers.get('x-request-id'), 'req_mock');
    assert.equal(seen[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(seen[0].headers['x-proxy-token'], undefined);
    assert.equal(seen[0].headers.authorization, headers.Authorization);
    assert.equal(seen[0].body, '{"stream":true}');
    const models = await mf.dispatchFetch('https://proxy.example/v1/models', { headers });
    assert.deepEqual(await models.json(), { data: [] });
  } finally { await mf.dispose(); }
});

test('workerd: real local HTTP disconnect cancels upstream stream', { timeout: 10000 }, async () => {
  const token = 'runtime-test-token-0123456789abcdef0123456789';
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    workers: [
      { name: 'proxy', modules: true, scriptPath: 'src/worker.js',
        compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'],
        bindings: { PROXY_TOKEN: token }, outboundService: 'mock' },
      { name: 'mock', modules: true, compatibilityDate: '2026-11-04',
        compatibilityFlags: ['enable_request_signal'],
        script: `let cancelled = false;
          export default { fetch(request) {
            if (new URL(request.url).pathname === '/__status') return Response.json({ cancelled });
            let timer;
            request.signal.addEventListener('abort', () => { cancelled = true; clearInterval(timer); });
            return new Response(new ReadableStream({
              start(controller) {
                const bytes = new TextEncoder().encode('data: {}\\n\\n');
                controller.enqueue(bytes);
                timer = setInterval(() => controller.enqueue(bytes), 50);
              },
              cancel() { cancelled = true; clearInterval(timer); },
            }), { headers: { 'content-type': 'text/event-stream' } });
          } };` },
    ],
  }));
  try {
    const address = await mf.ready;
    const controller = new AbortController();
    const res = await fetch(new URL('/v1/responses', address), { method: 'POST', body: '{}', signal: controller.signal, headers: { Authorization: 'Bearer fake-api-key', 'X-Proxy-Token': token } });
    assert.equal(res.status, 200);
    await res.body.getReader().read(); controller.abort();
    const mock = await mf.getWorker('mock');
    let cancelled = false;
    for (let i = 0; i < 40 && !cancelled; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      cancelled = (await (await mock.fetch('https://mock/__status')).json()).cancelled;
    }
    assert.equal(cancelled, true, 'upstream stream must receive cancellation');
  } finally { await mf.dispose(); }
});
