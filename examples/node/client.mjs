import OpenAI from 'openai';

const required = name => {
  if (!process.env[name]) throw new Error(`Set ${name}`);
  return process.env[name];
};
const baseURL = required('OPENAI_BASE_URL');
const url = new URL(baseURL);
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
if (!local && (url.protocol !== 'https:' || process.env.ALLOW_REAL_API !== '1')) {
  throw new Error('Remote API calls require HTTPS and explicit ALLOW_REAL_API=1');
}
const client = new OpenAI({
  baseURL, apiKey: required('OPENAI_API_KEY'),
  defaultHeaders: { 'X-Proxy-Token': required('PROXY_TOKEN') },
  maxRetries: 0, timeout: 120_000,
});
const model = required('OPENAI_MODEL');
const mode = process.argv[2] || 'responses';
const messages = [{ role: 'user', content: 'Say hello briefly.' }];
if (mode === 'chat' || mode === 'chat-stream') {
  const result = await client.chat.completions.create({ model, messages, stream: mode === 'chat-stream', max_completion_tokens: 128 });
  if (mode === 'chat-stream') {
    let completed = false;
    try {
      for await (const chunk of result) {
        const choice = chunk.choices[0];
        if (!choice) continue; // A usage-only chunk has no choices.
        process.stdout.write(choice.delta.content || '');
        if (choice.finish_reason != null) {
          if (choice.finish_reason !== 'stop') throw new Error('Chat text completion requires finish_reason=stop');
          completed = true;
        }
      }
      if (!completed) throw new Error('Chat stream ended without finish_reason=stop');
      console.log();
    } finally {
      result.controller.abort();
    }
  } else {
    if (result.choices[0]?.finish_reason !== 'stop') throw new Error('Chat text completion requires finish_reason=stop');
    console.log(result.choices[0].message.content);
  }
} else {
  const params = { model, input: 'Say hello briefly.', max_output_tokens: 128, store: false };
  if (mode === 'tools') Object.assign(params, {
    input: 'Call ping once.', tool_choice: 'required',
    tools: [{ type: 'function', name: 'ping', description: 'A harmless test function.', strict: true, parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  else if (mode === 'structured') Object.assign(params, {
    input: 'Return ok=true.', text: { format: { type: 'json_schema', name: 'result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
  });
  else if (!['responses', 'stream'].includes(mode)) throw new Error('Mode: responses | stream | tools | structured | chat | chat-stream');
  const result = await client.responses.create({ ...params, stream: mode === 'stream' });
  if (mode === 'stream') {
    let completed = false;
    try {
      for await (const event of result) {
        if (event.type === 'response.output_text.delta') process.stdout.write(event.delta);
        else if (event.type === 'response.completed') completed = true;
        else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          // Report the state, not upstream error content that may contain private data.
          throw new Error(`Responses stream ended with ${event.type}`);
        }
      }
      if (!completed) throw new Error('Responses stream ended without response.completed');
      console.log();
    } finally {
      result.controller.abort();
    }
  } else {
    if (result.status !== 'completed') throw new Error('Responses result not completed');
    console.log(mode === 'tools' ? JSON.stringify(result.output) : result.output_text);
  }
}
