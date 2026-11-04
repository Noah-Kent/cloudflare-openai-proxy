import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Use raw HTTP at both ends: Fetch/Response mocks or client auto-decompression
// hide the workerd fetch body's encoding semantics that caused this regression.
test('workerd: compressed upstream JSON and SSE remain valid gzip on the wire', { timeout: 15000 }, async t => {
  const token = 'compression-test-token-0123456789abcdef0123456789';
  let fixture;
  const origin = http.createServer((req, res) => {
    req.resume();
    res.writeHead(fixture.status, {
      'content-type': fixture.type, 'content-encoding': 'gzip',
      'content-length': fixture.encoded.length, 'x-request-id': 'req_compressed',
    });
    res.end(fixture.encoded);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'],
    bindings: { PROXY_TOKEN: token },
    // This bridge pipes HTTP bytes without decoding or constructing a Response.
    // All outbound traffic is routed to our loopback origin, never OpenAI.
    outboundService: { node: (req, res) => new Promise((resolve, reject) => {
      const upstream = http.request({
        hostname: '127.0.0.1', port: origin.address().port,
        path: '/mock', method: req.method, headers: req.headers,
      }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
        response.on('end', resolve);
        response.on('error', reject);
      });
      upstream.on('error', reject);
      req.pipe(upstream);
    }) },
  }));
  try {
    const address = await mf.ready;
    for (const [name, status, type, plain] of [
      ['JSON', 200, 'application/json', '{"status":"completed","text":"你好"}'],
      ['SSE', 200, 'text/event-stream', 'event: response.output_text.delta\ndata: {"delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n'],
      ['upstream error', 429, 'application/json', '{"error":{"message":"Mock rate limit"}}'],
    ]) {
      await t.test(name, async () => {
        fixture = { status, type, encoded: gzipSync(plain) };
        const actual = await new Promise((resolve, reject) => {
          const request = http.request(new URL('/v1/responses', address), {
            method: 'POST', headers: { Authorization: 'Bearer fake-api-key',
              'X-Proxy-Token': token, 'Accept-Encoding': 'gzip', 'Content-Type': 'application/json' },
          }, async response => {
            try {
              const chunks = [];
              for await (const chunk of response) chunks.push(chunk);
              resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
            } catch (error) { reject(error); }
          });
          request.setTimeout(5000, () => request.destroy(new Error('Local compression test timed out')));
          request.on('error', reject);
          request.end('{}');
        });
        assert.equal(actual.status, status);
        assert.equal(actual.headers['content-encoding'], 'gzip');
        assert.equal(actual.headers['content-type'], type);
        assert.equal(actual.headers['x-request-id'], 'req_compressed');
        assert.equal(gunzipSync(actual.body).toString(), plain);
        assert.deepEqual(actual.body, fixture.encoded, 'preserve the upstream compressed stream');
      });
    }
  } finally {
    await mf.dispose();
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  }
});
