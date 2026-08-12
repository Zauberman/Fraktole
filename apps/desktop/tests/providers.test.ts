import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../electron/reviewer/providers/anthropic.js';
import { OllamaProvider } from '../electron/reviewer/providers/ollama.js';
import { OpenAIProvider } from '../electron/reviewer/providers/openai.js';
import { createProvider } from '../electron/reviewer/providers.js';

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = lines.map((l) => encoder.encode(`data: ${l}\n\n`));
  return new ReadableStream({
    start(controller) {
      for (const b of body) controller.enqueue(b);
      controller.close();
    },
  });
}

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = lines.map((l) => encoder.encode(`${l}\n`));
  return new ReadableStream({
    start(controller) {
      for (const b of body) controller.enqueue(b);
      controller.close();
    },
  });
}

function stubFetch(body: ReadableStream<Uint8Array> | Response, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (body instanceof Response ? body : new Response(body, { status }))),
  );
}

const abort = new AbortController().signal;

function baseOpts() {
  return {
    model: 'test-model',
    apiKey: 'k',
    baseUrl: '',
    messages: [],
    tools: [{ name: 'read_tile', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    signal: abort,
    onDelta: () => undefined,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProvider', () => {
  it('returns the three known adapters and rejects unknown names', () => {
    expect(createProvider('openai')).toBeInstanceOf(OpenAIProvider);
    expect(createProvider('anthropic')).toBeInstanceOf(AnthropicProvider);
    expect(createProvider('ollama')).toBeInstanceOf(OllamaProvider);
    expect(() => createProvider('x')).toThrow('unknown reviewer provider');
  });
});

describe('OpenAIProvider', () => {
  it('streams a plain text reply', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"hel"}}]}', '{"choices":[{"delta":{"content":"lo"}}]}', '[DONE]']));
    const deltas: string[] = [];
    const res = await new OpenAIProvider().complete({ ...baseOpts(), onDelta: (d) => deltas.push(d) });
    expect(res.text).toBe('hello');
    expect(res.toolCalls).toEqual([]);
    expect(deltas).toEqual(['hel', 'lo']);
  });

  it('accumulates a tool call split across many deltas', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_tile","arguments":"{\\"agentId\\":"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"tile-1\\","}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"tail\\":5}"}}]}}]}',
        '{"choices":[{"delta":{"content":"ok"}}]}',
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.text).toBe('ok');
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'read_tile', args: { agentId: 'tile-1', tail: 5 } },
    ]);
  });

  it('reports API errors', async () => {
    stubFetch(new Response('nope', { status: 401 }), 401);
    await expect(new OpenAIProvider().complete(baseOpts())).rejects.toThrow('openai API error 401');
  });
});

describe('AnthropicProvider', () => {
  it('streams a plain text reply', async () => {
    stubFetch(
      sseStream([
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi "}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '{"type":"message_stop"}',
      ]),
    );
    const deltas: string[] = [];
    const res = await new AnthropicProvider().complete({ ...baseOpts(), onDelta: (d) => deltas.push(d) });
    expect(res.text).toBe('hi there');
    expect(deltas).toEqual(['hi ', 'there']);
    expect(res.toolCalls).toEqual([]);
  });

  it('collects a tool_use block with split input_json deltas', async () => {
    stubFetch(
      sseStream([
        '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"read_tile"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"agentId\\":\\"a1\\""}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":",\\"tail\\":3}"}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
        '{"type":"message_stop"}',
      ]),
    );
    const res = await new AnthropicProvider().complete(baseOpts());
    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'tu1', name: 'read_tile', args: { agentId: 'a1', tail: 3 } }]);
  });
});

describe('OllamaProvider', () => {
  it('streams a plain text reply', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"one "}}', '{"message":{"role":"assistant","content":"two"},"done":true}']));
    const deltas: string[] = [];
    const res = await new OllamaProvider().complete({ ...baseOpts(), onDelta: (d) => deltas.push(d) });
    expect(res.text).toBe('one two');
    expect(deltas).toEqual(['one ', 'two']);
  });

  it('maps tool_calls with stringified arguments', async () => {
    stubFetch(
      ndjsonStream([
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send_message","arguments":"{\\"to\\":\\"agent-1\\",\\"kind\\":\\"task\\",\\"body\\":\\"go\\"}"}}]},"done":true}',
      ]),
    );
    const res = await new OllamaProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([
      { id: 'tc-send_message-0', name: 'send_message', args: { to: 'agent-1', kind: 'task', body: 'go' } },
    ]);
  });
});
