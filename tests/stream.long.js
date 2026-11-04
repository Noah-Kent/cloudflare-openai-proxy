import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Deliberately separate from the fast suite. Local runtime, no real API.
test('workerd sustains a 65-second SSE stream with immediate first byte and intact order', { timeout: 90000 }, async () => {
  const token = 'long-stream-test-0123456789abcdef0123456789';
  let timer;
  const expected = Array.from({ length: 66 }, (_, i) => `id: ${i}\ndata: {"sequence":${i}}\n\n`);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'], bindings: { PROXY_TOKEN: token },
    outboundService: () => new Response(new ReadableStream({
      start(controller) {
        let i = 0; const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(expected[i++]));
        timer = setInterval(() => {
          controller.enqueue(encoder.encode(expected[i++]));
          if (i === expected.length) { clearInterval(timer); controller.close(); }
        }, 1000);
      },
      cancel() { clearInterval(timer); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  }));
  try {
    const address = await mf.ready;
    const started = performance.now();
    const res = await fetch(new URL('/v1/responses', address), { method: 'POST', body: '{"stream":true}', headers: { Authorization: 'Bearer fake-key', 'X-Proxy-Token': token } });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    let content = decoder.decode((await reader.read()).value, { stream: true });
    assert.ok(performance.now() - started < 5000, 'first bytes must arrive before stream completion');
    for (;;) { const { value, done } = await reader.read(); if (done) break; content += decoder.decode(value, { stream: true }); }
    content += decoder.decode();
    assert.equal(content, expected.join(''));
    assert.ok(performance.now() - started >= 64000, 'must actually sustain the elapsed duration');
  } finally { clearInterval(timer); await mf.dispose(); }
});
