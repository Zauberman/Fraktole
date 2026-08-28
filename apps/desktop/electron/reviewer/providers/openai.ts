import {
  joinBase,
  ssePayloads,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ProviderUsage,
  type ReviewerToolCall,
} from '../providers.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** True only for the genuine OpenAI/DeepSeek hosts — a corporate proxy or
 *  gateway (even one whose URL merely contains "api.openai.com") must not
 *  receive provider-specific fields it may reject. */
function isOfficialHost(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return host === 'api.openai.com' || host === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Exact DeepSeek host — the only host that must receive prior
 *  reasoning_content back. With the `tools` parameter present (always true
 *  for the reviewer harness) DeepSeek's thinking mode REQUIRES the
 *  reasoning_content of every previous turn in subsequent requests
 *  ("If your code does not correctly pass back reasoning_content, the API
 *  will return a 400 error"). OpenAI's reasoning models REJECT reasoning
 *  as input, so this stays an exact hostname gate. */
function isDeepseekHost(base: string): boolean {
  try {
    return new URL(base).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function toMessages(messages: ProviderMsg[], baseUrl: string): unknown[] {
  const out = messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content };
        // "tool_calls": [] is schema-invalid on OpenAI — omit it entirely
        // when there are no calls (also heals older persisted conversations)
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }));
        }
        // prior reasoning is only understood on the official deepseek
        // endpoint — never on openai.com (reasoning input is a 400) nor on
        // custom gateways (unknown fields risk a 400)
        if (m.thinking && m.thinking.length > 0 && isDeepseekHost(baseUrl)) {
          msg.reasoning_content = m.thinking;
        }
        return msg;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
  // last-chance wire guard: no message may ever carry an empty tool_calls
  // array, whatever produced it
  for (const m of out) {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(calls) && calls.length === 0) {
      console.log(`openai adapter: stripped empty tool_calls on role=${(m as { role?: string }).role}`);
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

/** OpenAI-compatible chat/completions with SSE streaming. Tool calls are
 *  accumulated per index: deltas may split ids, names and arguments. The
 *  reasoning output (deepseek reasoning_content, qwen/kimi/grok/glm
 *  variants) is captured into `thinking` and streamed as a second delta. */
export class OpenAIProvider implements ProviderClient {
  readonly name = 'openai' as const;

  async complete(opts: CompleteOpts): Promise<ProviderResult> {
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, '/chat/completions');
    const base = opts.baseUrl || DEFAULT_BASE;
    // usage is only returned on the final stream chunk when asked for — and
    // only official endpoints accept the field (custom proxies can 400), so
    // it is gated on the exact hostname
    const official = isOfficialHost(base);
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
        messages: toMessages(opts.messages, base),
        tools: toTools(opts.tools),
        ...(official ? { stream_options: { include_usage: true } } : {}),
        ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`openai API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let text = '';
    let thinking = '';
    let usage: ProviderUsage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string; lastFrag: string }>();
    const ensure = (i: number): { id: string; name: string; args: string; lastFrag: string } => {
      const cur = calls.get(i) ?? { id: '', name: '', args: '', lastFrag: '' };
      calls.set(i, cur);
      return cur;
    };

    for await (const payload of ssePayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      // some gateways report failures as HTTP 200 with an error payload —
      // surface it instead of silently replying with an empty turn
      const errField = (payload as { error?: { message?: string } }).error;
      if (errField) throw new Error(`openai stream error: ${errField.message ?? 'unknown'}`);
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
      // usage arrives on the final chunk (only with stream_options asked):
      // openai shape prompt_tokens/completion_tokens/prompt_tokens_details,
      // deepseek shape prompt_cache_hit_tokens/prompt_cache_miss_tokens
      const u = (payload as { usage?: unknown }).usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
          }
        | undefined;
      if (u && typeof u.prompt_tokens === 'number') {
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        usage = {
          inputTokens: u.prompt_tokens,
          cachedTokens: cached,
          outputTokens: u.completion_tokens ?? 0,
        };
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
        if (raw.function?.arguments) {
          // arguments arrive as token-boundary fragments (deepseek splits
          // even single tokens like `2` or `true` into their own delta) —
          // they must be concatenated, never replaced: a fragment that
          // happens to be valid JSON alone (a number, a literal) would
          // otherwise destroy the accumulated prefix. Providers that
          // re-send the FULL payload per delta are tolerated post-hoc in
          // parseArgs (the last fragment alone parses).
          cur.lastFrag = raw.function.arguments;
          cur.args += raw.function.arguments;
        }
      }
    }

    const toolCalls: ReviewerToolCall[] = [...calls.values()]
      .filter((c) => c.name.length > 0)
      // index-disambiguated fallback ids: two same-name calls without
      // provider ids must never share a tool_call_id
      .map((c, i) => ({ id: c.id || `tc-${c.name}-${i}`, name: c.name, args: parseArgs(c.args, c.lastFrag) }));
    return { text, toolCalls, thinking, usage };
  }
}

/** Parses the accumulated tool-call arguments. `lastFrag` is the final
 *  streamed fragment: a provider that re-sends the complete payload per
 *  delta accumulates `{a}{a}` — when the accumulated text does not parse
 *  but the last fragment alone does, the fragment IS the complete payload
 *  (full-resend tolerance, applied post-hoc so genuine fragment streams
 *  are never corrupted by it). */
function parseArgs(raw: string, lastFrag?: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    if (lastFrag && lastFrag.length > 0 && lastFrag !== raw) {
      try {
        return JSON.parse(lastFrag) as Record<string, unknown>;
      } catch {
        // fall through to _raw
      }
    }
    return { _raw: raw };
  }
}
