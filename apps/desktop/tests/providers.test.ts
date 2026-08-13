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

  it('captures reasoning_content deltas and streams them as thinking', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"reasoning_content":"let me think "}}]}',
        '{"choices":[{"delta":{"reasoning_content":"about the tiles"}}]}',
        '{"choices":[{"delta":{"content":"the answer"}}]}',
        '[DONE]',
      ]),
    );
    const events: Array<[string, string | undefined]> = [];
    const res = await new OpenAIProvider().complete({
      ...baseOpts(),
      onDelta: (d, t) => events.push([d, t]),
    });
    expect(res.thinking).toBe('let me think about the tiles');
    expect(res.text).toBe('the answer');
    expect(events).toEqual([
      ['', 'let me think '],
      ['', 'about the tiles'],
      ['the answer', undefined],
    ]);
  });

  it('accepts the other reasoning field names (reasoning/thinking/thinking_content)', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"thinking":"pondering "}}]}',
        '{"choices":[{"delta":{"reasoning":"more "}}]}',
        '{"choices":[{"delta":{"thinking_content":"even more"}}]}',
        '{"choices":[{"delta":{"content":"done"}}]}',
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.thinking).toBe('pondering more even more');
  });

  it('captures reasoning sent on the final chunk (choice.message.reasoning_content)', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"content":"x"}}]}',
        '{"choices":[{"delta":{},"message":{"reasoning_content":"final reasoning"}}]}',
        '{"choices":[{"delta":{},"message":{"reasoning_content":"final reasoning"}}]}',
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.thinking).toBe('final reasoning'); // deduped
  });

  it('captures reasoning on a final chunk with no delta at all', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"content":"a"}}]}',
        '{"choices":[{"message":{"reasoning_content":"qwen-style final reasoning"}}]}',
        '[DONE]',
      ]),
    );
    const events: Array<[string, string | undefined]> = [];
    const res = await new OpenAIProvider().complete({
      ...baseOpts(),
      onDelta: (d, t) => events.push([d, t]),
    });
    expect(res.thinking).toBe('qwen-style final reasoning');
    expect(res.text).toBe('a');
    expect(events).toContainEqual(['', 'qwen-style final reasoning']);
  });

  it('sends reasoning_effort only when set', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"x"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({ ...baseOpts(), reasoningEffort: 'high' });
    const body1 = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { reasoning_effort?: string };
    expect(body1.reasoning_effort).toBe('high');

    stubFetch(sseStream(['{"choices":[{"delta":{"content":"y"}}]}', '[DONE]']));
    await new OpenAIProvider().complete(baseOpts());
    const body2 = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { reasoning_effort?: string };
    expect(body2.reasoning_effort).toBeUndefined();
  });

  it('never sends an empty tool_calls array for a text-only assistant message', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'plain text reply', toolCalls: [] },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { messages: Array<{ tool_calls?: unknown }> };
    expect('tool_calls' in body.messages[1]!).toBe(false);
  });

  it('still maps real tool calls in the request', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { agentId: 'a1' } }] },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ tool_calls?: Array<{ id: string; function: { name: string } }> }>;
    };
    expect(body.messages[1]!.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_tile', arguments: '{"agentId":"a1"}' } },
    ]);
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

  it('captures extended-thinking blocks as thinking', async () => {
    stubFetch(
      sseStream([
        '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"first thought "}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"second thought"}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}',
        '{"type":"content_block_stop","index":1}',
        '{"type":"message_stop"}',
      ]),
    );
    const events: Array<[string, string | undefined]> = [];
    const res = await new AnthropicProvider().complete({
      ...baseOpts(),
      onDelta: (d, t) => events.push([d, t]),
    });
    expect(res.thinking).toBe('first thought second thought');
    expect(res.text).toBe('answer');
    expect(events).toEqual([
      ['', 'first thought '],
      ['', 'second thought'],
      ['answer', undefined],
    ]);
  });

  it('requests extended thinking on every call', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete(baseOpts());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { thinking?: unknown };
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('never sends an empty content array for a reasoning-only assistant message', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [] },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const blocks = body.messages[1]!.content;
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]!.type).toBe('text');
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

  it('never sends an empty tool_calls array (same contract as openai)', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"ok"},"done":true}']));
    await new OllamaProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'plain text reply', toolCalls: [] },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { messages: Array<{ tool_calls?: unknown }> };
    expect('tool_calls' in body.messages[1]!).toBe(false);
  });

  it('captures message.thinking as thinking', async () => {
    stubFetch(
      ndjsonStream([
        '{"message":{"role":"assistant","thinking":"mulling "}}',
        '{"message":{"role":"assistant","thinking":"it over"},"done":false}',
        '{"message":{"role":"assistant","content":"final"},"done":true}',
      ]),
    );
    const events: Array<[string, string | undefined]> = [];
    const res = await new OllamaProvider().complete({
      ...baseOpts(),
      onDelta: (d, t) => events.push([d, t]),
    });
    expect(res.thinking).toBe('mulling it over');
    expect(res.text).toBe('final');
    expect(events).toEqual([
      ['', 'mulling '],
      ['', 'it over'],
      ['final', undefined],
    ]);
  });
});
