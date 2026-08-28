import {
  joinBase,
  ssePayloads,
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
        // strictly larger than the thinking budget: extended-thinking
        // tokens count against max_tokens, so a fully-used budget must
        // still leave room for the actual reply
        max_tokens: 8192,
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
    let usage: ProviderUsage | undefined;
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

    for await (const payload of ssePayloads(res.body as ReadableStream<Uint8Array<ArrayBufferLike>>)) {
      const ev = payload as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string; thinking?: string };
        delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      switch (ev.type) {
        case 'message_start':
          if (ev.message?.usage) {
            usage = {
              inputTokens: ev.message.usage.input_tokens ?? 0,
              cachedTokens: (ev.message.usage.cache_read_input_tokens ?? 0) + (ev.message.usage.cache_creation_input_tokens ?? 0),
              outputTokens: 0,
            };
          }
          break;
        case 'message_delta':
        case 'message_stop':
          if (ev.usage?.output_tokens && usage) usage.outputTokens = ev.usage.output_tokens;
          break;
        case 'content_block_start': {
          const type = ev.content_block?.type;
          // a new start while a block is open means a lost
          // content_block_stop — fail loudly instead of silently merging
          // (for nested tool_use) or delivering a truncated block
          if (openBlock && (type === 'tool_use' || openBlock.kind === 'tool')) {
            throw new Error('anthropic stream error: nested content block');
          }
          if (type === 'tool_use') {
            const call: ReviewerToolCall = {
              id: ev.content_block?.id ?? '',
              name: ev.content_block?.name ?? '',
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
            const seed = ev.content_block?.thinking;
            if (seed && seed.length > 0) {
              block.thinking = seed;
              thinking += seed;
              opts.onDelta('', seed);
            }
          }
          break;
        }
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            opts.onDelta(ev.delta.text);
            if (openBlock?.kind === 'text') openBlock.block.text = (openBlock.block.text ?? '') + ev.delta.text;
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            thinking += ev.delta.thinking;
            opts.onDelta('', ev.delta.thinking);
            if (openBlock?.kind === 'thinking') openBlock.block.thinking = (openBlock.block.thinking ?? '') + ev.delta.thinking;
          } else if (ev.delta?.type === 'signature_delta' && ev.delta.signature) {
            // the thinking block's signature arrives as its own delta just
            // before content_block_stop — it must ride along with the
            // replayed block or the API rejects the continuation
            if (openBlock?.kind === 'thinking') openBlock.block.signature = ev.delta.signature;
          } else if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json) {
            // a delta with no open block means a lost content_block_stop —
            // fail loudly instead of running the tool with empty args
            if (!openBlock || openBlock.kind !== 'tool') throw new Error('anthropic stream error: input_json_delta without an open block');
            openBlock.raw = (openBlock.raw ?? '') + ev.delta.partial_json;
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

    return {
      text,
      toolCalls: [...calls.values()],
      thinking,
      contentBlocks: blocks.length > 0 ? blocks : undefined,
      usage,
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
