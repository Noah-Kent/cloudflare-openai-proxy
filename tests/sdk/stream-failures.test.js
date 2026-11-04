import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const run = promisify(execFile);
const token = 'stream-regression-token-0123456789abcdef0123456789';
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

test('delivered Responses examples distinguish completed, failed, incomplete and truncated streams', { timeout: 30000 }, async t => {
  let terminal;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'], bindings: { PROXY_TOKEN: token },
    outboundService: async request => {
      assert.equal(request.headers.get('x-proxy-token'), null);
      assert.equal(request.headers.get('authorization'), 'Bearer fake-api-key');
      const events = [{ type: 'response.output_text.delta', sequence_number: 0,
        item_id: 'msg_mock', output_index: 0, content_index: 0, delta: 'partial' }];
      if (terminal !== 'eof') events.push({ type: `response.${terminal}`, sequence_number: 1,
        response: { id: 'resp_mock', object: 'response', created_at: 1, model: 'mock',
          status: terminal, output: [],
          error: terminal === 'failed' ? { code: 'server_error', message: 'Synthetic upstream failure' } : null,
          incomplete_details: terminal === 'incomplete' ? { reason: 'max_output_tokens' } : null } });
      return new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  }));
  try {
    const env = { ...process.env, OPENAI_BASE_URL: `${await mf.ready}v1`, OPENAI_API_KEY: 'fake-api-key',
      PROXY_TOKEN: token, OPENAI_MODEL: 'mock', ALLOW_REAL_API: '0', NO_PROXY: '127.0.0.1,localhost' };
    for (terminal of ['failed', 'incomplete', 'eof', 'completed']) {
      for (const [name, binary, script] of [
        ['Node', process.execPath, 'examples/node/client.mjs'],
        ['Python', process.env.PYTHON || '.venv/bin/python', 'examples/python/client.py'],
      ]) {
        await t.test(`${name}: ${terminal}`, async () => {
          const result = await run(binary, [script, 'stream'], { env, timeout: 10000 })
            .then(r => ({ ...r, code: 0 }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
          assert.match(result.stdout, /partial/);
          if (terminal === 'completed') {
            assert.equal(result.code, 0); assert.equal(result.stderr, '');
          } else {
            assert.equal(result.code, 1, 'failed or unconfirmed response must not exit successfully');
            assert.match(result.stderr, terminal === 'eof' ? /without response\.completed/ : new RegExp(`response\\.${terminal}`));
          }
        });
      }
    }
  } finally { await mf.dispose(); }
});
