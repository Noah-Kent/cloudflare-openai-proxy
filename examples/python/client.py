import os
import sys
from urllib.parse import urlparse
from openai import OpenAI

base_url = os.environ['OPENAI_BASE_URL']
url = urlparse(base_url)
local = url.hostname in ('127.0.0.1', 'localhost', '::1')
if not local and (url.scheme != 'https' or os.environ.get('ALLOW_REAL_API') != '1'):
    raise RuntimeError('Remote API calls require HTTPS and explicit ALLOW_REAL_API=1')
mode = sys.argv[1] if len(sys.argv) > 1 else 'responses'
model = os.environ['OPENAI_MODEL']
with OpenAI(base_url=base_url, api_key=os.environ['OPENAI_API_KEY'],
            default_headers={'X-Proxy-Token': os.environ['PROXY_TOKEN']},
            max_retries=0, timeout=120) as client:
    if mode in ('chat', 'chat-stream'):
        result = client.chat.completions.create(model=model, messages=[{'role': 'user', 'content': 'Say hello briefly.'}],
                                                stream=mode == 'chat-stream', max_completion_tokens=128)
        if mode == 'chat-stream':
            completed = False
            try:
                for chunk in result:
                    if not chunk.choices:  # A usage-only chunk has no choices.
                        continue
                    choice = chunk.choices[0]
                    print(choice.delta.content or '', end='', flush=True)
                    if choice.finish_reason is not None:
                        if choice.finish_reason != 'stop':
                            raise RuntimeError('Chat text completion requires finish_reason=stop')
                        completed = True
                if not completed:
                    raise RuntimeError('Chat stream ended without finish_reason=stop')
                print()
            finally:
                result.close()
        else:
            if not result.choices or result.choices[0].finish_reason != 'stop':
                raise RuntimeError('Chat text completion requires finish_reason=stop')
            print(result.choices[0].message.content)
    else:
        params = dict(model=model, input='Say hello briefly.', max_output_tokens=128, store=False)
        if mode == 'tools':
            params.update(input='Call ping once.', tool_choice='required', tools=[{
                'type': 'function', 'name': 'ping', 'description': 'A harmless test function.', 'strict': True,
                'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}])
        elif mode == 'structured':
            params.update(input='Return ok=true.', text={'format': {'type': 'json_schema', 'name': 'result', 'strict': True,
                'schema': {'type': 'object', 'properties': {'ok': {'type': 'boolean'}}, 'required': ['ok'], 'additionalProperties': False}}})
        elif mode not in ('responses', 'stream'):
            raise RuntimeError('Mode: responses | stream | tools | structured | chat | chat-stream')
        result = client.responses.create(**params, stream=mode == 'stream')
        if mode == 'stream':
            completed = False
            try:
                for event in result:
                    if event.type == 'response.output_text.delta':
                        print(event.delta, end='', flush=True)
                    elif event.type == 'response.completed':
                        completed = True
                    elif event.type in ('response.failed', 'response.incomplete', 'error'):
                        # Report the state without echoing private upstream error content.
                        raise RuntimeError(f'Responses stream ended with {event.type}')
                if not completed:
                    raise RuntimeError('Responses stream ended without response.completed')
                print()
            finally:
                result.close()
        else:
            if result.status != 'completed':
                raise RuntimeError('Responses result not completed')
            print(result.output if mode == 'tools' else result.output_text)
