import {
  joinBase,
  ndjsonPayloads,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ReviewerToolCall,
} from '../providers.js';

const DEFAULT_BASE = 'http://localhost:11434';

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
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        };
      case 'tool':
        return { role: 'tool', content: m.content };
    }
  });
}

function toTools(tools: CompleteOpts['tools']): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Ollama /api/chat with NDJSON streaming. Tool calls arrive in a single
 *  non-streaming chunk carrying a `function.arguments` JSON string. Reasoning
 *  models stream `message.thinking` — captured into `thinking`. */
export class OllamaProvider implements ProviderClient {
  readonly name = 'ollama' as const;

  async complete(opts: CompleteOpts): Promise<ProviderResult> {
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, '/api/chat');
    const res = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        messages: toMessages(opts.messages),
        tools: toTools(opts.tools),
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let text = '';
    let thinking = '';
    const toolCalls: ReviewerToolCall[] = [];

    for await (const payload of ndjsonPayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      const msg = (payload as { message?: { content?: string; thinking?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }).message;
      if (!msg) continue;
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        text += msg.content;
        opts.onDelta(msg.content);
      }
      if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
        thinking += msg.thinking;
        opts.onDelta('', msg.thinking);
      }
      for (const tc of msg.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        toolCalls.push({
          id: `tc-${name}-${toolCalls.length}`,
          name,
          args: parseArgs(tc.function?.arguments ?? ''),
        });
      }
    }

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
