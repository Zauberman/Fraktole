import {
  joinBase,
  ssePayloads,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ReviewerToolCall,
} from '../providers.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Extended thinking budget; reasoning is always enabled so the thinking
 *  output is capturable. 4096 — the reviewer is a judge and deeper thinking
 *  pays for itself. */
const THINKING_BUDGET_TOKENS = 4096;

function toMessages(messages: ProviderMsg[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        break;
      case 'assistant': {
        const content: unknown[] = [];
        if (m.content.length > 0) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
        }
        out.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        });
        break;
    }
  }
  return { system, messages: out };
}

/** Anthropic Messages API with SSE event streaming. Tool calls arrive as
 *  content blocks (start → input_json_delta → stop); extended thinking is
 *  enabled and its `thinking` blocks are captured into `thinking`. */
export class AnthropicProvider implements ProviderClient {
  readonly name = 'anthropic' as const;

  async complete(opts: CompleteOpts): Promise<ProviderResult> {
    const { system, messages } = toMessages(opts.messages);
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, '/v1/messages');
    const res = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        system: system.length > 0 ? system : undefined,
        messages,
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        stream: true,
        thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let text = '';
    let thinking = '';
    const calls = new Map<string, ReviewerToolCall>();
    let openBlock: { call: ReviewerToolCall; raw: string } | null = null;

    for await (const payload of ssePayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      const ev = payload as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string; thinking?: string };
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
      };
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            openBlock = {
              call: { id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', args: {} },
              raw: '',
            };
            calls.set(openBlock.call.id, openBlock.call);
          } else if (ev.content_block?.type === 'thinking' && ev.content_block.thinking) {
            thinking += ev.content_block.thinking;
            opts.onDelta('', ev.content_block.thinking);
          }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            opts.onDelta(ev.delta.text);
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            thinking += ev.delta.thinking;
            opts.onDelta('', ev.delta.thinking);
          } else if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json && openBlock) {
            openBlock.raw += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop': {
          if (openBlock) {
            openBlock.call.args = parseArgs(openBlock.raw);
            openBlock = null;
          }
          break;
        }
      }
    }

    return { text, toolCalls: [...calls.values()], thinking };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
