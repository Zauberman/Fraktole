import {
  joinBase,
  ssePayloads,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ReviewerToolCall,
} from '../providers.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

function toMessages(messages: ProviderMsg[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function toTools(tools: CompleteOpts['tools']): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** OpenAI-compatible chat/completions with SSE streaming. Tool calls are
 *  accumulated per index: deltas may split ids, names and arguments. The
 *  reasoning output (deepseek reasoning_content, qwen/kimi/grok/glm
 *  variants) is captured into `thinking` and streamed as a second delta. */
export class OpenAIProvider implements ProviderClient {
  readonly name = 'openai' as const;

  async complete(opts: CompleteOpts): Promise<ProviderResult> {
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, '/chat/completions');
    const res = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        max_tokens: 4096,
        messages: toMessages(opts.messages),
        tools: toTools(opts.tools),
        ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`openai API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let text = '';
    let thinking = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const ensure = (i: number): { id: string; name: string; args: string } => {
      const cur = calls.get(i) ?? { id: '', name: '', args: '' };
      calls.set(i, cur);
      return cur;
    };

    for await (const payload of ssePayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      const choice = (payload as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string; thinking_content?: string; tool_calls?: unknown[] };
          message?: { reasoning_content?: string };
        }>;
      }).choices?.[0];
      // some providers send the reasoning only on the final chunk, inside
      // choice.message with no delta at all — check before the delta guard
      const msgReason = choice?.message?.reasoning_content;
      if (typeof msgReason === 'string' && msgReason.length > 0 && !thinking.includes(msgReason)) {
        thinking += msgReason;
        opts.onDelta('', msgReason);
      }
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        opts.onDelta(delta.content);
      }
      // reasoning output: tolerant across providers (deepseek/qwen/kimi/glm
      // use reasoning_content; grok and others vary).
      const reason =
        delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? delta.thinking_content;
      if (typeof reason === 'string' && reason.length > 0) {
        thinking += reason;
        opts.onDelta('', reason);
      }
      for (const tc of delta.tool_calls ?? []) {
        const raw = tc as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
        const cur = ensure(raw.index ?? 0);
        if (raw.id) cur.id = raw.id;
        if (raw.function?.name) cur.name = raw.function.name;
        if (raw.function?.arguments) cur.args += raw.function.arguments;
      }
    }

    const toolCalls: ReviewerToolCall[] = [...calls.values()]
      .filter((c) => c.name.length > 0)
      .map((c) => ({ id: c.id || `tc-${c.name}`, name: c.name, args: parseArgs(c.args) }));
    return { text, toolCalls, thinking };
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
