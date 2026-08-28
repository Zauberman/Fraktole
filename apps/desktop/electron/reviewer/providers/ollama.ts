import {
  joinBase,
  ndjsonPayloads,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ProviderUsage,
  type ReviewerToolCall,
} from '../providers.js';

const DEFAULT_BASE = 'http://localhost:11434';

function toMessages(messages: ProviderMsg[]): unknown[] {
  const out = messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content };
        // never send an empty tool_calls array (same contract as openai)
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            // Ollama 0.22+ speaks object-form `arguments` on the wire BOTH
            // ways: it rejects the stringified form in request history with
            // 400 "Value looks like object, but can't find closing '}'".
            // The args are already normalized objects (parseArgs) — send them
            // as-is so the tool-call history replays without a 400.
            function: { name: c.name, arguments: c.args },
          }));
        }
        // The `thinking` message field round-trips: templates and renderers
        // expose the message's Thinking content to the model's prompt, so a
        // reasoning model continues from its own prior chain-of-thought
        // instead of starting fresh after every tool result. Non-thinking
        // models ignore the field (no 400 — the API schema accepts it).
        if (m.thinking && m.thinking.length > 0) {
          msg.thinking = m.thinking;
        }
        return msg;
      }
      case 'tool':
        return { role: 'tool', content: m.content };
    }
  });
  // last-chance wire guard: no message may ever carry an empty tool_calls
  // array, whatever produced it
  for (const m of out) {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls) && calls.length === 0) {
      console.log(`ollama adapter: stripped empty tool_calls on role=${(m as { role?: string }).role}`);
      delete (m as { tool_calls?: unknown }).tool_calls;
    }
  }
  return out;
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
    let usage: ProviderUsage | undefined;
    const toolCalls: ReviewerToolCall[] = [];
    let toolSeq = 0; // monotonic per-turn suffix for generated ids

    for await (const payload of ndjsonPayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      // ollama reports several failures as HTTP 200 with an error field —
      // surface them instead of silently replying with an empty turn
      const errField = (payload as { error?: string }).error;
      if (errField) throw new Error(`ollama API error: ${errField}`);
      const msg = (payload as {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string | Record<string, unknown> | null } }>;
        };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      }).message;
      const done = (payload as { done?: boolean }).done;
      if (done && typeof (payload as { prompt_eval_count?: number }).prompt_eval_count === 'number') {
        usage = {
          inputTokens: (payload as { prompt_eval_count: number }).prompt_eval_count,
          cachedTokens: 0,
          outputTokens: (payload as { eval_count?: number }).eval_count ?? 0,
        };
      }
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
          // monotonic counter: toolCalls.length resets per message and
          // would collide across iterations of the same tool
          id: `tc-${name}-${toolSeq++}`,
          name,
          args: parseArgs(tc.function?.arguments ?? ''),
        });
      }
    }

    return { text, toolCalls, thinking, usage };
  }
}

/** Tool-call arguments arrive in two shapes across Ollama versions: a JSON
 *  string ('{"a":4}') or, on newer builds, an already-parsed JSON object
 *  ({"a":4}). parseArgs is total over the union — and null/undefined map to
 *  an empty object, so nobody downstream ever calls .trim() on a non-string. */
function parseArgs(raw: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return { _raw: raw };
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
