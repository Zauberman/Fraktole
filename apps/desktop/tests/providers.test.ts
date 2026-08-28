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

  it('keeps full arguments when a fragment is independently-valid JSON (deepseek token-boundary split)', async () => {
    // the exact split captured from api.deepseek.com: numbers and literals
    // stream as their own delta (`2`, `20`, `true`) — a fragment that is
    // valid JSON alone must never replace the accumulated prefix
    const frags = ['{', '"', 'path', '"', ': ', '"', 'front', 'end', '/src', '"', ', ', '"', 'depth', '"', ': ', '2', '}'];
    stubFetch(
      sseStream([
        ...frags.map((f, i) =>
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    i === 0
                      ? { index: 0, id: 'c1', function: { name: 'list_dir', arguments: f } }
                      : { index: 0, function: { arguments: f } },
                  ],
                },
              },
            ],
          }),
        ),
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'list_dir', args: { path: 'frontend/src', depth: 2 } }]);
  });

  it('keeps the prefix across multiple calls when number fragments stream standalone', async () => {
    const listFrags = ['{', '"', 'path', '"', ': ', '"', 'frontend', '"', ', ', '"', 'depth', '"', ': ', '2', '}'];
    const killFrags = ['{', '"', 'agentId', '"', ': ', '"', 'agent', '-', '1', '"', '}'];
    const lines: string[] = [];
    listFrags.forEach((f, i) =>
      lines.push(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  i === 0
                    ? { index: 0, id: 'c1', function: { name: 'list_dir', arguments: f } }
                    : { index: 0, function: { arguments: f } },
                ],
              },
            },
          ],
        }),
      ),
    );
    killFrags.forEach((f, i) =>
      lines.push(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  i === 0
                    ? { index: 1, id: 'c2', function: { name: 'kill_agent', arguments: f } }
                    : { index: 1, function: { arguments: f } },
                ],
              },
            },
          ],
        }),
      ),
    );
    lines.push('[DONE]');
    stubFetch(sseStream(lines));
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'list_dir', args: { path: 'frontend', depth: 2 } },
      { id: 'c2', name: 'kill_agent', args: { agentId: 'agent-1' } },
    ]);
  });

  it('still tolerates providers that re-send the full payload per delta (post-hoc fallback)', async () => {
    const full = '{"agentId":"tile-1","tail":5}';
    stubFetch(
      sseStream([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_tile', arguments: full } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: full } }] } }] }),
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    // accumulated `{a}{a}` does not parse — the last fragment alone is the payload
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'read_tile', args: { agentId: 'tile-1', tail: 5 } }]);
  });

  it('marks genuinely corrupt accumulated arguments as _raw', async () => {
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_tile","arguments":"2}"}}]}}]}',
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'read_tile', args: { _raw: '2}' } }]);
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

  it('applies the standard sampler knobs (max_tokens, temperature, top_p, seed, penalties)', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"x"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      knobs: { maxOutputTokens: 1024, temperature: 0.4, topP: 0.9, seed: 7, presencePenalty: 0.5, frequencyPenalty: -0.5 },
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.9);
    expect(body.seed).toBe(7);
    expect(body.presence_penalty).toBe(0.5);
    expect(body.frequency_penalty).toBe(-0.5);
  });

  it('never sends ollama-only knob fields (top_k/min_p/repeat_penalty/keep_alive/think/options)', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"x"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      knobs: { contextTokens: 32768, topK: 20, minP: 0.1, repeatPenalty: 1.2, keepAlive: '5m', think: true },
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096); // no maxOutputTokens → today's default
    for (const f of ['temperature', 'top_p', 'seed', 'top_k', 'min_p', 'repeat_penalty', 'keep_alive', 'think', 'options']) {
      expect(f in body).toBe(false);
    }
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

  it('replays reasoning_content on assistant messages for the official deepseek host', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      baseUrl: 'https://api.deepseek.com/v1',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'prev reply', thinking: 'prior chain of thought' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('prior chain of thought');
  });

  it('never sends reasoning_content to openai.com or custom hosts', async () => {
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        { role: 'assistant', content: 'prev reply', thinking: 'thoughts' },
        { role: 'user', content: 'next' },
      ],
    });
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']));
    await new OpenAIProvider().complete({
      ...baseOpts(),
      baseUrl: 'https://gateway.example.com/v1',
      messages: [
        { role: 'assistant', content: 'prev reply', thinking: 'thoughts' },
        { role: 'user', content: 'next' },
      ],
    });
    for (const call of vi.mocked(fetch).mock.calls) {
      const body = JSON.parse(String(call[1]!.body)) as { messages: Array<{ reasoning_content?: unknown }> };
      for (const m of body.messages) expect(m.reasoning_content).toBeUndefined();
    }
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

  it('asks for usage only on official endpoints and parses the final chunk', async () => {
    // official deepseek endpoint: stream_options + usage parsed
    stubFetch(
      sseStream([
        '{"choices":[{"delta":{"content":"x"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":40}}}',
        '[DONE]',
      ]),
    );
    const res = await new OpenAIProvider().complete({ ...baseOpts(), baseUrl: 'https://api.deepseek.com' });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { stream_options?: unknown };
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(res.usage).toEqual({ inputTokens: 100, cachedTokens: 40, outputTokens: 7 });

    // deepseek's own cache fields
    stubFetch(
      sseStream([
        '{"choices":[],"usage":{"prompt_tokens":90,"completion_tokens":3,"prompt_cache_hit_tokens":60}}',
        '[DONE]',
      ]),
    );
    const res2 = await new OpenAIProvider().complete({ ...baseOpts(), baseUrl: 'https://api.deepseek.com' });
    expect(res2.usage?.cachedTokens).toBe(60);

    // custom endpoint: no stream_options, no usage
    stubFetch(sseStream(['{"choices":[{"delta":{"content":"y"}}]}', '[DONE]']));
    const res3 = await new OpenAIProvider().complete({ ...baseOpts(), baseUrl: 'https://gateway.example.com/v1' });
    const body3 = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { stream_options?: unknown };
    expect(body3.stream_options).toBeUndefined();
    expect(res3.usage).toBeUndefined();
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

  it('captures thinking blocks with their signatures', async () => {
    stubFetch(
      sseStream([
        '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"first "}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"second"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-1"}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"checked"}}',
        '{"type":"content_block_stop","index":1}',
        '{"type":"message_stop"}',
      ]),
    );
    const res = await new AnthropicProvider().complete(baseOpts());
    expect(res.thinking).toBe('first second');
    expect(res.text).toBe('checked');
    expect(res.contentBlocks).toEqual([
      { type: 'thinking', thinking: 'first second', signature: 'SIG-1' },
      { type: 'text', text: 'checked' },
    ]);
  });

  it('replays captured blocks verbatim when the assistant turn is continued', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: 'checked',
          toolCalls: [{ id: 'tu1', name: 'read_tile', args: { agentId: 'a1' } }],
          contentBlocks: [
            { type: 'thinking', thinking: 'first second', signature: 'SIG-1' },
            { type: 'tool_use', id: 'tu1', name: 'read_tile', input: { agentId: 'a1' } },
          ],
        },
        { role: 'tool', content: 'ok', toolCallId: 'tu1' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'first second', signature: 'SIG-1' },
      { type: 'tool_use', id: 'tu1', name: 'read_tile', input: { agentId: 'a1' } },
    ]);
  });

  it('falls back to a text/tool_use-only rebuild when thinking lacks its signature', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: 'maybe',
          toolCalls: [{ id: 'tu1', name: 'read_tile', args: { agentId: 'a1' } }],
          // unsigned thinking block — must never go back on the wire
          contentBlocks: [{ type: 'thinking', thinking: 'orphan' }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'tu1' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'text', text: 'maybe' },
      { type: 'tool_use', id: 'tu1', name: 'read_tile', input: { agentId: 'a1' } },
    ]);
  });

  it('requests extended thinking on every call', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete(baseOpts());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { thinking?: unknown };
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('applies max output (clamped to the thinking floor), temperature and top_p', async () => {
    // 4000 is below the 8192 floor the extended-thinking budget requires —
    // the adapter clamps up instead of letting the API 400
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({ ...baseOpts(), knobs: { maxOutputTokens: 4000, temperature: 0.5, topP: 0.8 } });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.8);

    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({ ...baseOpts(), knobs: { maxOutputTokens: 16384 } });
    const body2 = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body2.max_tokens).toBe(16384);
  });

  it('never sends fields anthropic does not accept (seed, penalties, keep_alive, think, options)', async () => {
    stubFetch(sseStream(['{"type":"message_stop"}']));
    await new AnthropicProvider().complete({
      ...baseOpts(),
      knobs: { seed: 7, presencePenalty: 1, frequencyPenalty: 1, topK: 20, minP: 0.1, repeatPenalty: 1.1, keepAlive: '5m', think: true },
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    for (const f of ['seed', 'presence_penalty', 'frequency_penalty', 'top_k', 'min_p', 'repeat_penalty', 'keep_alive', 'think', 'options']) {
      expect(f in body).toBe(false);
    }
    expect(body.max_tokens).toBe(8192); // default preserved
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

  it('parses usage from message_start and message_delta', async () => {
    stubFetch(
      sseStream([
        '{"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}}}',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
        '{"type":"message_stop"}',
      ]),
    );
    const res = await new AnthropicProvider().complete(baseOpts());
    expect(res.usage).toEqual({ inputTokens: 200, cachedTokens: 90, outputTokens: 25 });
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

  it('maps tool_calls whose arguments arrive as an already-parsed object (newer ollama builds)', async () => {
    stubFetch(
      ndjsonStream([
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"add","arguments":{"a":4,"b":3}}}]},"done":true}',
      ]),
    );
    const res = await new OllamaProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([{ id: 'tc-add-0', name: 'add', args: { a: 4, b: 3 } }]);
    expect(res.text).toBe('');
  });

  it('maps tool_calls with null or missing arguments to an empty object', async () => {
    stubFetch(
      ndjsonStream([
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"ping","arguments":null}},{"function":{"name":"noop"}}]},"done":true}',
      ]),
    );
    const res = await new OllamaProvider().complete(baseOpts());
    expect(res.toolCalls).toEqual([
      { id: 'tc-ping-0', name: 'ping', args: {} },
      { id: 'tc-noop-1', name: 'noop', args: {} },
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

  it('replays thinking on assistant messages', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'prev reply', thinking: 'prior chain of thought' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; thinking?: string }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toBe('prior chain of thought');
  });

  it('omits thinking when the assistant message has none', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"ok"},"done":true}']));
    await new OllamaProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'plain' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; thinking?: string }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect('thinking' in assistant!).toBe(false);
  });

  it('replays tool-call history with object-form arguments (ollama 0.22+ rejects strings)', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete({
      ...baseOpts(),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'x-1', name: 'send_message', args: { to: 'agent-1', kind: 'task' } }] },
        { role: 'tool', content: 'ok', toolCallId: 'x-1' },
        { role: 'user', content: 'next' },
      ],
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      messages: Array<{ role: string; tool_calls?: Array<{ function?: { arguments?: unknown } }> }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    const args = assistant?.tool_calls?.[0]?.function?.arguments;
    expect(args).toEqual({ to: 'agent-1', kind: 'task' });
    expect(typeof args).toBe('object');
  });

  it('builds the options map plus keep_alive/think from the knobs', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete({
      ...baseOpts(),
      knobs: {
        contextTokens: 65536,
        maxOutputTokens: 1024,
        temperature: 0.3,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        seed: 9,
        repeatPenalty: 1.1,
        presencePenalty: 0.5,
        frequencyPenalty: -0.5,
        keepAlive: '2h',
        think: true,
      },
    });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as {
      options?: Record<string, unknown>;
      keep_alive?: string;
      think?: boolean;
    };
    expect(body.options).toEqual({
      num_ctx: 65536,
      num_predict: 1024,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      seed: 9,
      repeat_penalty: 1.1,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
    });
    expect(body.keep_alive).toBe('2h');
    expect(body.think).toBe(true);
  });

  it('clamps num_predict to the 512 floor (truncated tool JSON would break the loop)', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete({ ...baseOpts(), knobs: { maxOutputTokens: 10 } });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as { options?: Record<string, unknown> };
    expect(body.options).toEqual({ num_predict: 512 });
  });

  it('omits options entirely when no sampler knob is set (byte-identical to knob-less config)', async () => {
    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete({ ...baseOpts(), knobs: { think: false } });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.options).toBeUndefined();
    expect(body.think).toBe(false);

    stubFetch(ndjsonStream(['{"message":{"role":"assistant","content":"done"},"done":true}']));
    await new OllamaProvider().complete(baseOpts());
    // stubFetch replaces the fetch mock — the knob-less request is calls[0]
    const body2 = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect('options' in body2).toBe(false);
    expect('think' in body2).toBe(false);
    expect('keep_alive' in body2).toBe(false);
  });

  it('parses eval counts from the final done chunk', async () => {
    stubFetch(
      ndjsonStream([
        '{"message":{"role":"assistant","content":"hi"},"done":false}',
        '{"message":{"role":"assistant","content":" there"},"done":true,"prompt_eval_count":500,"eval_count":42}',
      ]),
    );
    const res = await new OllamaProvider().complete(baseOpts());
    expect(res.usage).toEqual({ inputTokens: 500, cachedTokens: 0, outputTokens: 42 });
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
