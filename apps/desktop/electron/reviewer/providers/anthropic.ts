import {
  joinBase,
  parseRetryAfterMs,
  ProviderHttpError,
  sseEvents,
  type CompleteOpts,
  type ProviderClient,
  type ProviderMsg,
  type ProviderResult,
  type ProviderUsage,
  type ReviewerToolCall,
  type WireContentBlock,
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
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    switch (m.role) {
      case 'user':
        out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        break;
      case 'assistant': {
        // Verbatim replay is REQUIRED when a thinking-enabled turn is
        // continued with tool results: the thinking blocks (with their
        // signatures) must accompany the tool_use blocks exactly as the
        // model generated them — the API rejects modified or rebuilt
        // thinking blocks with a 400. The captured blocks are already in
        // wire shape, so they are emitted untouched.
        const blocks = m.contentBlocks && m.contentBlocks.length > 0 ? m.contentBlocks : null;
        if (blocks && !hasUnsignedThinking(blocks)) {
          out.push({ role: 'assistant', content: blocks });
          break;
        }
        // Safeguard fallback: a thinking block captured WITHOUT its
        // signature (older builds, truncated stream) must not go back on
        // the wire — unsigned thinking blocks are rejected. Rebuild the
        // assistant from text/tool_use only; thinking continuity degrades
        // but the request stays valid.
        const content: unknown[] = [];
        if (m.content.length > 0) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
        }
        // an assistant block must carry at least one content block (a
        // reasoning-only reply with no text would otherwise be rejected)
        if (content.length === 0) content.push({ type: 'text', text: '(no text)' });
        out.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        // batch consecutive tool results into ONE user message — the
        // documented Anthropic shape; N separate user messages can 400 on
        // strict "roles must alternate" enforcement
        const blocks: unknown[] = [
          { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content },
        ];
        while (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
          i += 1;
          const next = messages[i]!;
          blocks.push({ type: 'tool_result', tool_use_id: next.toolCallId, content: next.content });
        }
        out.push({ role: 'user', content: blocks });
        break;
      }
    }
  }
  return { system, messages: out };
}

/** Anthropic Messages API with SSE event streaming. Tool calls arrive as
 *  content blocks (start → input_json_delta → stop); extended thinking is
 *  enabled and its `thinking` blocks are captured into `thinking` — and
 *  captured VERBATIM (with signatures) into `contentBlocks` so a
 *  tool-use loop can echo the assistant turn back unmodified. */
export class AnthropicProvider implements ProviderClient {
  readonly name = 'anthropic' as const;

  async complete(opts: CompleteOpts): Promise<ProviderResult> {
    const { system, messages } = toMessages(opts.messages);
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, '/v1/messages');
    // thinking policy: undefined = the pre-knob default (extended thinking
    // on with the default budget). Off omits the field entirely.
    const policy = opts.thinking ?? { mode: 'on' as const, budgetTokens: THINKING_BUDGET_TOKENS };
    const thinkingOn = policy.mode === 'on';
    const budget = policy.budgetTokens ?? THINKING_BUDGET_TOKENS;
    // extended-thinking tokens count against max_tokens, so the cap must
    // stay strictly larger than the thinking budget — a user-set cap below
    // the floor is clamped (silently lowering it would 400). Default floor:
    // 4096 budget + 4096 text headroom = 8192. Off needs no headroom.
    const floor = thinkingOn ? budget + 4096 : 0;
    const userCap = opts.knobs?.maxOutputTokens;
    const maxTokens = thinkingOn ? Math.max(userCap ?? floor, floor) : userCap ?? 4096;
    if (thinkingOn && userCap !== undefined && userCap < floor) {
      console.log(`anthropic adapter: maxOutputTokens ${userCap} clamped to ${floor} (extended-thinking budget ${budget})`);
    }
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
        max_tokens: maxTokens,
        system: system.length > 0 ? system : undefined,
        messages,
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        // anthropic sampler fields only — no seed/penalties/keep_alive/think
        ...(opts.knobs?.temperature !== undefined ? { temperature: opts.knobs.temperature } : {}),
        ...(opts.knobs?.topP !== undefined ? { top_p: opts.knobs.topP } : {}),
        stream: true,
        ...(thinkingOn ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      throw new ProviderHttpError('anthropic', res.status, parseRetryAfterMs(res.headers.get('retry-after')), (await res.text()).slice(0, 300));
    }

    let text = '';
    let thinking = '';
    let usage: ProviderUsage | undefined;
    let stopReason: string | undefined;
    let sawStop = false;
    const calls = new Map<string, ReviewerToolCall>();
    /** The turn's content blocks in generation order (verbatim wire shape). */
    const blocks: WireContentBlock[] = [];
    /** The single currently-open content block (anthropic streams blocks
     *  strictly sequentially: start → deltas → stop). */
    let openBlock: {
      block: WireContentBlock;
      kind: 'tool' | 'text' | 'thinking';
      raw?: string;
      call?: ReviewerToolCall;
    } | null = null;

    for await (const ev of sseEvents(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      if (ev.done) break;
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (payload === undefined) continue;
      const p = payload as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string; thinking?: string };
        delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      switch (p.type) {
        case 'message_start':
          if (p.message?.usage) {
            usage = {
              inputTokens: p.message.usage.input_tokens ?? 0,
              cachedTokens: (p.message.usage.cache_read_input_tokens ?? 0) + (p.message.usage.cache_creation_input_tokens ?? 0),
              outputTokens: 0,
            };
          }
          break;
        case 'message_delta':
          if (p.delta?.stop_reason) stopReason = p.delta.stop_reason;
          if (p.usage?.output_tokens) {
            if (usage) usage.outputTokens = p.usage.output_tokens;
            else usage = { inputTokens: 0, cachedTokens: 0, outputTokens: p.usage.output_tokens };
          }
          break;
        case 'message_stop':
          sawStop = true;
          break;
        case 'content_block_start': {
          const type = p.content_block?.type;
          // a new start while a block is open means a lost
          // content_block_stop — fail loudly for ANY kind: a text restart
          // would otherwise leave the first block truncated in contentBlocks
          // while the aggregate text carries everything (replay divergence)
          if (openBlock) {
            throw new Error('anthropic stream error: nested content block');
          }
          if (type === 'tool_use') {
            const call: ReviewerToolCall = {
              id: p.content_block?.id ?? '',
              name: p.content_block?.name ?? '',
              args: {},
            };
            const block: WireContentBlock = { type: 'tool_use', id: call.id, name: call.name, input: {} };
            blocks.push(block);
            openBlock = { block, kind: 'tool', raw: '', call };
            calls.set(call.id, call);
          } else if (type === 'text') {
            const block: WireContentBlock = { type: 'text', text: '' };
            blocks.push(block);
            openBlock = { block, kind: 'text' };
          } else if (type === 'thinking') {
            const block: WireContentBlock = { type: 'thinking', thinking: '', signature: '' };
            blocks.push(block);
            openBlock = { block, kind: 'thinking' };
            const seed = p.content_block?.thinking;
            if (seed && seed.length > 0) {
              block.thinking = seed;
              thinking += seed;
              opts.onDelta('', seed);
            }
          }
          break;
        }
        case 'content_block_delta':
          if (p.delta?.type === 'text_delta' && p.delta.text) {
            text += p.delta.text;
            opts.onDelta(p.delta.text);
            if (openBlock?.kind === 'text') openBlock.block.text = (openBlock.block.text ?? '') + p.delta.text;
          } else if (p.delta?.type === 'thinking_delta' && p.delta.thinking) {
            thinking += p.delta.thinking;
            opts.onDelta('', p.delta.thinking);
            if (openBlock?.kind === 'thinking') openBlock.block.thinking = (openBlock.block.thinking ?? '') + p.delta.thinking;
          } else if (p.delta?.type === 'signature_delta' && p.delta.signature) {
            // the thinking block's signature arrives as its own delta just
            // before content_block_stop — it must ride along with the
            // replayed block or the API rejects the continuation
            if (openBlock?.kind === 'thinking') openBlock.block.signature = p.delta.signature;
          } else if (p.delta?.type === 'input_json_delta' && p.delta.partial_json) {
            // a delta with no open block means a lost content_block_stop —
            // fail loudly instead of running the tool with empty args
            if (!openBlock || openBlock.kind !== 'tool') throw new Error('anthropic stream error: input_json_delta without an open block');
            openBlock.raw = (openBlock.raw ?? '') + p.delta.partial_json;
          }
          break;
        case 'content_block_stop': {
          if (openBlock) {
            if (openBlock.kind === 'tool') {
              const args = parseArgs(openBlock.raw ?? '');
              openBlock.call!.args = args;
              openBlock.block.input = args;
            }
            openBlock = null;
          }
          break;
        }
      }
    }

    // a stream that dies before message_stop (connection close, gateway
    // crash) was cut off — never treat the partial reply as complete
    if (!sawStop) {
      throw new Error('anthropic stream ended prematurely — connection closed before message_stop');
    }
    return {
      text,
      toolCalls: [...calls.values()],
      thinking,
      contentBlocks: blocks.length > 0 ? blocks : undefined,
      usage,
      finishReason: stopReason ?? 'end_turn',
    };
  }
}

/** True when the captured blocks contain a thinking block without its
 *  signature — such blocks may NOT be replayed (the API rejects unsigned
 *  thinking blocks), so the caller must degrade to the text/tool_use-only
 *  rebuild. */
function hasUnsignedThinking(blocks: WireContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'thinking' && !b.signature);
}

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
