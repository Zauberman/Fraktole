import {
  joinBase,
  normalizeOpenaiBase,
  sseEvents,
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
  // Prior reasoning is replayed only where the server understands it:
  //  - official deepseek REQUIRES it back (400 without it),
  //  - any server that EMITTED thinking previously (a loading
  //    qwen/kimi-style reasoning model on llama.cpp, LM Studio, vLLM…)
  //    continues its chain-of-thought instead of restarting — our Qwen3.6
  //    boot relies on this,
  //  - the official OpenAI host REJECTS reasoning as input (400) — never
  //    send it there.
  const official = isOfficialHost(baseUrl);
  const anyPriorThinking = messages.some((m) => m.role === 'assistant' && (m.thinking?.length ?? 0) > 0);
  const replayThinking = isDeepseekHost(baseUrl) || (!official && anyPriorThinking);
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
        // gateways that never emitted thinking (unknown fields risk a 400)
        if (m.thinking && m.thinking.length > 0 && replayThinking) {
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
    const base = normalizeOpenaiBase(opts.baseUrl || DEFAULT_BASE);
    const url = joinBase(base, '/chat/completions');
    // usage (and the token accounting it feeds) needs stream_options on
    // every endpoint — local servers (llama.cpp, vLLM, LM Studio) support it
    // too. A strict gateway that rejects the field 400s; retry once without.
    const bodyFor = (includeUsage: boolean): string =>
      JSON.stringify({
        model: opts.model,
        stream: true,
        max_tokens: opts.knobs?.maxOutputTokens ?? 4096,
        messages: toMessages(opts.messages, base),
        tools: toTools(opts.tools),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
        // standard chat/completions sampler fields — safe on every
        // OpenAI-compatible endpoint, so no hostname gate (unlike
        // reasoning_effort/stream_options). Top_k/min_p/repeat_penalty/
        // keep_alive/think are NOT chat.completions fields and are never
        // sent here.
        ...(opts.knobs?.temperature !== undefined ? { temperature: opts.knobs.temperature } : {}),
        ...(opts.knobs?.topP !== undefined ? { top_p: opts.knobs.topP } : {}),
        ...(opts.knobs?.seed !== undefined ? { seed: opts.knobs.seed } : {}),
        ...(opts.knobs?.presencePenalty !== undefined ? { presence_penalty: opts.knobs.presencePenalty } : {}),
        ...(opts.knobs?.frequencyPenalty !== undefined ? { frequency_penalty: opts.knobs.frequencyPenalty } : {}),
      });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // keyless local servers (llama.cpp etc.) get no Authorization header at
    // all — an empty "Bearer " is one 401 away on strict local gateways
    if (opts.apiKey.length > 0) headers.authorization = `Bearer ${opts.apiKey}`;
    let res = await fetch(url, { method: 'POST', signal: opts.signal, headers, body: bodyFor(true) });
    if (!res.ok && !res.body) {
      throw new Error(`openai API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // a server that rejects stream_options outright (older LocalAI /
      // htmx-style gateways) gets one retry without it
      if (res.status === 400 && /stream_options|include_usage/i.test(text)) {
        res = await fetch(url, { method: 'POST', signal: opts.signal, headers, body: bodyFor(false) });
        if (!res.ok || !res.body) {
          throw new Error(`openai API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
      } else {
        throw new Error(`openai API error ${res.status}: ${text}`);
      }
    }
    if (!res.body) throw new Error(`openai API error ${res.status}: empty body`);

    let text = '';
    let thinking = '';
    let finishReason: string | undefined;
    let sawDone = false;
    let usage: ProviderUsage | undefined;
    const calls = new Map<number | string, { id: string; name: string; args: string; lastFrag: string }>();
    const ensure = (i: number | string): { id: string; name: string; args: string; lastFrag: string } => {
      const cur = calls.get(i) ?? { id: '', name: '', args: '', lastFrag: '' };
      calls.set(i, cur);
      return cur;
    };

    for await (const ev of sseEvents(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      if (ev.done) {
        sawDone = true;
        break;
      }
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (payload === undefined) continue;
      // some gateways report failures as HTTP 200 with an error payload —
      // surface it instead of silently replying with an empty turn
      const errField = (payload as { error?: { message?: string } }).error;
      if (errField) throw new Error(`openai stream error: ${errField.message ?? 'unknown'}`);
      const choice = (payload as {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string; thinking_content?: string; tool_calls?: unknown[] };
          message?: { reasoning_content?: string };
          finish_reason?: string | null;
        }>;
      }).choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
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
        // non-conformant gateways emit parallel calls without index — key
        // by id when present so the calls do not collapse into bucket 0
        const key = raw.index ?? (raw.id !== undefined ? `id:${raw.id}` : 0);
        const cur = ensure(key);
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

    // a stream that ends without the final completion chunk ([DONE] or a
    // finish_reason) was cut off — a crashed local server must never look
    // like a completed turn
    if (finishReason === undefined && !sawDone) {
      throw new Error('openai stream ended prematurely — connection closed before the final chunk');
    }
    const toolCalls: ReviewerToolCall[] = [...calls.values()]
      .filter((c) => c.name.length > 0)
      // index-disambiguated fallback ids: two same-name calls without
      // provider ids must never share a tool_call_id
      .map((c, i) => ({ id: c.id || `tc-${c.name}-${i}`, name: c.name, args: parseArgs(c.args, c.lastFrag) }));
    return { text, toolCalls, thinking, usage, finishReason: finishReason ?? 'stop' };
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
