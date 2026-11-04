import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import OpenAI from 'openai';

const token = 'sdk-test-token-0123456789abcdef0123456789';
const response = (output) => ({ id: 'resp_mock', object: 'response', created_at: 1, status: 'completed', model: 'mock-model', output });
const message = (text) => ({ type: 'message', id: 'msg_mock', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const chat = (message, stream = false) => ({ id: 'chat_mock', object: stream ? 'chat.completion.chunk' : 'chat.completion', created: 1, model: 'mock-model', choices: [{ index: 0, ...(stream ? { delta: message } : { message }), finish_reason: stream ? null : 'stop' }] });
const sse = (events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

test('official Node and Python SDKs -> workerd -> Mock upstream', { timeout: 30000 }, async () => {
  const seen = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'], bindings: { PROXY_TOKEN: token },
    outboundService: async request => {
      assert.equal(new URL(request.url).origin, 'https://api.openai.com');
      assert.equal(request.headers.get('x-proxy-token'), null);
      assert.equal(request.headers.get('authorization'), 'Bearer fake-sdk-api-key');
      const body = request.method === 'GET' ? {} : await request.json();
      seen.push({ path: new URL(request.url).pathname, body });
      if (request.url.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
      if (body.model === 'error-model') return Response.json({ error: { message: 'Mock rate limit', type: 'rate_limit_error' } }, { status: 429 });
      if (request.url.endsWith('/chat/completions')) {
        if (body.stream) {
          const terminal = chat({}, true);
          terminal.choices[0].finish_reason = 'stop';
          return new Response(`data: ${JSON.stringify(chat({ content: 'hello' }, true))}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }
        return Response.json(chat(body.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock', type: 'function', function: { name: 'ping', arguments: '{}' } }] } : { role: 'assistant', content: 'hello' }));
      }
      const result = response(body.tools ? [{ type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'ping', arguments: '{}', status: 'completed' }] : [message(body.text ? '{"ok":true}' : 'hello')]);
      if (body.stream) return new Response(sse([
        { type: 'response.created', sequence_number: 0, response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_mock', output_index: 0, content_index: 0, delta: 'hello' },
        { type: 'response.completed', sequence_number: 2, response: result },
      ]), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json(result);
    },
  }));
  try {
    const baseURL = `${await mf.ready}v1`;
    const client = new OpenAI({ baseURL, apiKey: 'fake-sdk-api-key', defaultHeaders: { 'X-Proxy-Token': token }, maxRetries: 0, timeout: 10000 });
    assert.equal((await client.models.list()).data[0].id, 'mock-model');
    assert.equal((await client.responses.create({ model: 'mock-model', input: 'hi' })).output_text, 'hello');
    const events = [];
    for await (const e of await client.responses.create({ model: 'mock-model', input: 'hi', stream: true })) events.push(e.type);
    assert.deepEqual(events, ['response.created', 'response.output_text.delta', 'response.completed']);
    const tools = [{ type: 'function', name: 'ping', parameters: { type: 'object', properties: {} }, strict: false }];
    assert.equal((await client.responses.create({ model: 'mock-model', input: 'ping', tools })).output[0].name, 'ping');
    assert.equal((await client.responses.create({ model: 'mock-model', input: 'ok', text: { format: { type: 'json_schema', name: 'result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } })).output_text, '{"ok":true}');
    assert.equal((await client.chat.completions.create({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })).choices[0].message.content, 'hello');
    let output = '';
    for await (const e of await client.chat.completions.create({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], stream: true })) output += e.choices[0].delta.content || '';
    assert.equal(output, 'hello');
    assert.equal((await client.chat.completions.create({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }] })).choices[0].message.tool_calls[0].function.name, 'ping');
    await assert.rejects(client.responses.create({ model: 'error-model', input: 'hi' }), e => e.status === 429);
    const { stdout } = await promisify(execFile)(process.env.PYTHON || '.venv/bin/python', ['tests/sdk/python_smoke.py', baseURL], { timeout: 20000 });
    assert.match(stdout, /9 Mock scenarios passed/);
    assert.equal(seen.length, 18);
    assert.equal(seen.filter(r => r.body.tools).length, 4);
    assert.equal(seen.filter(r => r.body.text?.format.type === 'json_schema').length, 2);
    // Execute the delivered examples, not only equivalent SDK calls.
    const exampleEnv = { ...process.env, OPENAI_BASE_URL: baseURL, OPENAI_API_KEY: 'fake-sdk-api-key',
      PROXY_TOKEN: token, OPENAI_MODEL: 'mock-model', ALLOW_REAL_API: '0', NO_PROXY: '127.0.0.1,localhost' };
    for (const mode of ['responses', 'stream', 'tools', 'structured', 'chat', 'chat-stream']) {
      for (const [binary, script] of [[process.execPath, 'examples/node/client.mjs'], [process.env.PYTHON || '.venv/bin/python', 'examples/python/client.py']]) {
        const { stdout } = await promisify(execFile)(binary, [script, mode], { env: exampleEnv, timeout: 10000 });
        assert.match(stdout, mode === 'tools' ? /ping/ : mode === 'structured' ? /"ok":true/ : /hello/);
      }
    }
    assert.equal(seen.length, 30);
  } finally { await mf.dispose(); }
});
