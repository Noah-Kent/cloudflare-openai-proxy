import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const run = promisify(execFile);
const token = 'completion-test-token-0123456789abcdef0123456789';
const privateMessage = 'Synthetic-private-upstream-detail';
const chat = (stream, finish_reason, content = 'partial') => ({
  id: 'chat_mock', object: stream ? 'chat.completion.chunk' : 'chat.completion',
  created: 1, model: 'mock', choices: [{ index: 0, finish_reason,
    ...(stream ? { delta: { content } } : { message: { role: 'assistant', content } }) }],
});
const cases = [];
for (const mode of ['responses', 'tools', 'structured']) {
  for (const status of ['failed', 'incomplete', 'completed']) {
    cases.push({ mode, status, success: status === 'completed', error: /Responses.*not completed/ });
  }
}
for (const status of ['in_progress', 'missing']) {
  cases.push({ mode: 'responses', status, success: false, error: /Responses.*not completed/ });
}
for (const mode of ['chat', 'chat-stream']) {
  for (const status of ['length', 'content_filter', 'tool_calls', 'eof', 'stop']) {
    cases.push({ mode, status, success: status === 'stop', error: /Chat.*(finish_reason|without)/ });
  }
}
cases.push({ mode: 'chat-stream', status: 'done-only', success: false, error: /Chat.*without/ });
cases.push({ mode: 'chat-stream', status: 'stop-with-usage', success: true });
cases.push({ mode: 'chat-stream', status: 'stop-with-eof', success: true });

test('delivered examples reject incomplete Responses and unfinished text Chat completions', { timeout: 60000 }, async t => {
  let current;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'src/worker.js', host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-11-04', compatibilityFlags: ['enable_request_signal'], bindings: { PROXY_TOKEN: token },
    outboundService: async request => {
      const body = await request.json();
      if (request.url.endsWith('/chat/completions')) {
        const finish = ['eof', 'done-only'].includes(current.status) ? null : current.status.replace(/-with-(usage|eof)$/, '');
        if (!body.stream) return Response.json(chat(false, finish));
        const chunks = [chat(true, null)];
        if (finish) chunks.push(chat(true, finish, ''));
        if (current.status === 'stop-with-usage') chunks.push({
          ...chat(true, null), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        const wire = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          (['eof', 'stop-with-eof'].includes(current.status) ? '' : 'data: [DONE]\n\n');
        return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ id: 'resp_mock', object: 'response', created_at: 1, model: 'mock',
        ...(current.status === 'missing' ? {} : { status: current.status }),
        output: body.tools ? [{ type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'ping', arguments: '{}', status: 'completed' }] :
          [{ type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: body.text ? '{"ok":true}' : 'partial', annotations: [] }] }],
        error: current.status === 'failed' ? { code: 'server_error', message: privateMessage } : null,
        incomplete_details: current.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      });
    },
  }));
  try {
    const env = { ...process.env, OPENAI_BASE_URL: `${await mf.ready}v1`, OPENAI_API_KEY: 'fake-api-key',
      PROXY_TOKEN: token, OPENAI_MODEL: 'mock', ALLOW_REAL_API: '0', NO_PROXY: '127.0.0.1,localhost' };
    for (current of cases) {
      for (const [name, binary, script] of [
        ['Node', process.execPath, 'examples/node/client.mjs'],
        ['Python', process.env.PYTHON || '.venv/bin/python', 'examples/python/client.py'],
      ]) {
        await t.test(`${name}: ${current.mode} ${current.status}`, async () => {
          const result = await run(binary, [script, current.mode], { env, timeout: 10000 })
            .then(r => ({ ...r, code: 0 }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
          assert.equal(result.code, current.success ? 0 : 1, 'exit code must reflect completion');
          assert.ok(!`${result.stdout}${result.stderr}`.includes(privateMessage), 'do not echo upstream error details');
          if (current.success) {
            assert.equal(result.stderr, '');
            assert.match(result.stdout, current.mode === 'tools' ? /ping/ : current.mode === 'structured' ? /"ok":true/ : /partial/);
          } else {
            assert.match(result.stderr, current.error);
            if (current.mode !== 'chat-stream') assert.equal(result.stdout, '', 'do not print incomplete results as final output');
          }
        });
      }
    }
  } finally { await mf.dispose(); }
});
