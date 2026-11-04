import sys
import httpx
from openai import OpenAI, RateLimitError

base_url = sys.argv[1]
assert base_url.startswith('http://127.0.0.1:'), 'Mock test must stay on loopback'
with OpenAI(base_url=base_url, api_key='fake-sdk-api-key',
            default_headers={'X-Proxy-Token': 'sdk-test-token-0123456789abcdef0123456789'},
            max_retries=0, timeout=10, http_client=httpx.Client(trust_env=False)) as client:
    assert client.models.list().data[0].id == 'mock-model'
    assert client.responses.create(model='mock-model', input='hi').output_text == 'hello'
    stream = client.responses.create(model='mock-model', input='hi', stream=True)
    assert [e.type for e in stream] == ['response.created', 'response.output_text.delta', 'response.completed']
    tool = {'type': 'function', 'name': 'ping', 'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}, 'strict': True}
    assert client.responses.create(model='mock-model', input='call ping', tools=[tool]).output[0].name == 'ping'
    structured = client.responses.create(model='mock-model', input='return ok', text={'format': {'type': 'json_schema', 'name': 'result', 'strict': True, 'schema': {'type': 'object', 'properties': {'ok': {'type': 'boolean'}}, 'required': ['ok'], 'additionalProperties': False}}})
    assert structured.output_text == '{"ok":true}'
    assert client.chat.completions.create(model='mock-model', messages=[{'role': 'user', 'content': 'hi'}]).choices[0].message.content == 'hello'
    stream = client.chat.completions.create(model='mock-model', messages=[{'role': 'user', 'content': 'hi'}], stream=True)
    assert ''.join(c.choices[0].delta.content or '' for c in stream) == 'hello'
    tool_chat = client.chat.completions.create(model='mock-model', messages=[{'role': 'user', 'content': 'ping'}], tools=[{'type': 'function', 'function': {'name': 'ping', 'parameters': {'type': 'object', 'properties': {}}}}])
    assert tool_chat.choices[0].message.tool_calls[0].function.name == 'ping'
    try:
        client.responses.create(model='error-model', input='hi')
        raise AssertionError('expected 429')
    except RateLimitError as exc:
        assert exc.status_code == 429
print('Python SDK: 9 Mock scenarios passed')
