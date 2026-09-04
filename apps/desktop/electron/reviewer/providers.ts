/** Provider contracts for the reviewer harness: one shape, three adapters.
 *  The harness talks to models over plain HTTP streaming — no SDKs, so the
 *  whole provider surface is testable with stubbed fetch + fixtures. */

export type { SamplerKnobs } from '../../src/shared/ipc.js';
import type { SamplerKnobs } from '../../src/shared/ipc.js';

export type ProviderName = 'openai' | 'anthropic' | 'ollama';

export interface ReviewerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ReviewerToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A verbatim wire content block captured from an assistant turn
 *  (anthropic thinking/text/tool_use blocks, signature included). Replayed
 *  exactly as received so provider-side continuity rules hold (anthropic
 *  requires thinking blocks to accompany tool_use blocks unmodified).
 *  Never interpreted by the harness itself. */
export interface WireContentBlock {
  type: 'thinking' | 'text' | 'tool_use' | string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/** The harness's normalized conversation message. */
export interface ProviderMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant only */
  toolCalls?: ReviewerToolCall[];
  /** tool only: which call this result answers */
  toolCallId?: string;
  /** user only (in-memory): the message was already emitted to the
   *  renderer at queue time — run() must not emit it again. Never
   *  persisted. */
  announced?: boolean;
  /** assistant only: the model's reasoning output, captured from the
   *  provider's thinking field (deepseek reasoning_content, ollama
   *  thinking, anthropic thinking blocks, ...). Persisted with the
   *  message and re-sent by the adapters whose providers require or
   *  support it (deepseek reasoning_content on official hosts, ollama
   *  `thinking`, anthropic thinking blocks with signature). */
  thinking?: string;
  /** assistant only: the provider's verbatim content blocks of this turn
   *  (anthropic capture; ignored by the other adapters). Replayed as-is
   *  for thinking/tool-use continuity. */
  contentBlocks?: WireContentBlock[];
}

/** The user's thinking policy, resolved from the sampler knobs. The
 *  harness sends it only when the user forced on/off — 'auto' and unset
 *  both arrive as undefined so the adapter keeps its default behavior. */
export interface ProviderThinking {
  mode: 'on' | 'off';
  /** anthropic only: the extended-thinking budget in tokens. */
  budgetTokens?: number;
}

export interface CompleteOpts {
  model: string;
  apiKey: string;
  /** Base URL override ('' = provider default). */
  baseUrl: string;
  messages: ProviderMsg[];
  tools: ReviewerTool[];
  signal: AbortSignal;
  /** Reasoning effort for models that support it; undefined = provider default. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Model-tuning knobs; each adapter applies only the fields its wire
   *  format accepts (ollama options.*, openai/anthropic standard fields).
   *  Undefined = provider defaults, nothing extra sent. */
  knobs?: SamplerKnobs;
  /** The thinking policy for adapters that support it. Undefined = adapter
   *  defaults (anthropic: extended thinking on with its default budget —
   *  the pre-knob behavior; ollama: nothing sent, server decides; openai:
   *  reasoningEffort rules instead). */
  thinking?: ProviderThinking;
  /** Streamed deltas, delivered as they arrive: content text and/or a
   *  thinking delta (the provider's reasoning output). */
  onDelta: (text: string, thinking?: string) => void;
}

/** Token usage of one request/response pair (from the provider's usage
 *  block; providers without usage leave it undefined). */
export interface ProviderUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  text: string;
  toolCalls: ReviewerToolCall[];
  /** Full reasoning output of the turn ('' when the provider sent none). */
  thinking: string;
  /** The provider's verbatim content blocks of this turn (anthropic
   *  capture; undefined elsewhere). Replayed as-is for thinking
   *  continuity in tool loops. */
  contentBlocks?: WireContentBlock[];
  /** Token usage when the provider reports it (streamed or final). */
  usage?: ProviderUsage;
  /** The provider's own stop reason (openai/others: 'stop' | 'length' |
   *  'tool_calls' | …; anthropic: 'end_turn' | 'max_tokens' | 'tool_use';
   *  ollama: done_reason). 'length'/'max_tokens' means the generation was
   *  CLIPPED — the harness compacts and continues instead of trusting a
   *  truncated reply. Always set: a stream that simply dies mid-flight
   *  (connection close, server crash) is a failed attempt, never a turned
   *  silent success. */
  finishReason: string;
}

export interface ProviderClient {
  readonly name: ProviderName;
  complete(opts: CompleteOpts): Promise<ProviderResult>;
}

/** An HTTP-level failure from a provider. Carries the status so the
 *  harness classifies retries from data instead of regexing message text,
 *  plus the server's Retry-After hint (429/5xx) when present. */
export class ProviderHttpError extends Error {
  constructor(
    name: ProviderName,
    readonly status: number,
    /** Parsed Retry-After hint in ms, or undefined when the server sent none. */
    readonly retryAfterMs: number | undefined,
    body: string,
  ) {
    super(`${name} API error ${status}: ${body}`);
    this.name = 'ProviderHttpError';
  }
}

/** Parses a Retry-After header: delta-seconds or an HTTP-date. Caps at
 *  RETRY_AFTER_CAP_MS so a hostile hint cannot park the loop for minutes. */
export const RETRY_AFTER_CAP_MS = 120_000;
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    return Math.min(RETRY_AFTER_CAP_MS, Math.round(Number(s) * 1000));
  }
  const date = Date.parse(s);
  if (!Number.isNaN(date)) {
    return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - Date.now()));
  }
  return undefined;
}

import { AnthropicProvider } from './providers/anthropic.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';

export function createProvider(name: string): ProviderClient {
  switch (name) {
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      throw new Error(`unknown reviewer provider: ${name}`);
  }
}

export function joinBase(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Normalizes a user-supplied OpenAI-compatible base URL: strips a pasted
 *  full `/chat/completions` suffix, and appends the `/v1` path the
 *  OpenAI-compatible surface requires (llama.cpp, LM Studio, vLLM are all
 *  mounted there). A base already carrying a `/v1` path is untouched.
 *  Ollama-native bases (/api/…) and scheme-less junk are returned as-is —
 *  this never invents a URL for a URL that doesn't parse. */
export function normalizeOpenaiBase(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (raw.length === 0) return raw;
  try {
    const u = new URL(raw);
    let p = u.pathname.replace(/\/+$/, '');
    if (p.endsWith('/chat/completions')) p = p.slice(0, -'/chat/completions'.length);
    if (!p.endsWith('/v1')) p = `${p.replace(/\/+$/, '')}/v1`;
    u.pathname = p;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

/** Reads a web ReadableStream byte-by-byte (the generic variance of
 *  ReadableStream across @types/node makes `for await` on the stream type
 *  unreliable; bytes are bytes regardless). */
export async function* readBytes(body: ReadableStream<Uint8Array<ArrayBufferLike>>): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** SSE reader: yields parsed JSON payloads of `data:` lines until [DONE].
 *  Malformed payloads are skipped (one bad line must never kill the turn),
 *  and a final event without a trailing newline is still delivered. */
export async function* ssePayloads(body: ReadableStream<Uint8Array<ArrayBufferLike>>): AsyncGenerator<unknown> {
  let buf = '';
  for await (const chunk of readBytes(body)) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data.length === 0) continue;
      try {
        yield JSON.parse(data) as unknown;
      } catch {
        // malformed payload — skip
      }
    }
  }
  // flush an unterminated tail: the final chunk may carry the usage block
  // or [DONE] without a trailing newline
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data === '[DONE]') return;
    if (data.length > 0) {
      try {
        yield JSON.parse(data) as unknown;
      } catch {
        // malformed payload — skip
      }
    }
  }
}

/** SSE reader that keeps completion visible: yields parsed JSON payloads
 *  for `data:` lines, a `{ done: true }` sentinel for [DONE], and closes on
 *  EOF. A turn that ends WITHOUT either a done sentinel or a final
 *  `finish_reason` chunk is premature (connection closed, server crash) —
 *  the adapters must treat that as a failed attempt, not a silent success.
 *  Malformed payloads are skipped (one bad line must never kill the turn). */
export interface SseEvent {
  payload?: unknown;
  done: boolean;
}

export async function* sseEvents(body: ReadableStream<Uint8Array<ArrayBufferLike>>): AsyncGenerator<SseEvent> {
  let buf = '';
  for await (const chunk of readBytes(body)) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        yield { done: true };
        return;
      }
      if (data.length === 0) continue;
      try {
        yield { payload: JSON.parse(data) as unknown, done: false };
      } catch {
        // malformed payload — skip
      }
    }
  }
  // flush an unterminated tail: the final chunk may carry the usage block
  // or [DONE] without a trailing newline
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data === '[DONE]') yield { done: true };
    else if (data.length > 0) {
      try {
        yield { payload: JSON.parse(data) as unknown, done: false };
      } catch {
        // malformed payload — skip
      }
    }
  }
}

/** NDJSON reader (ollama-style streaming). Malformed lines are skipped and
 *  a final unterminated line (the done/usage chunk) is still delivered. */
export async function* ndjsonPayloads(body: ReadableStream<Uint8Array<ArrayBufferLike>>): AsyncGenerator<unknown> {
  let buf = '';
  for await (const chunk of readBytes(body)) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        // malformed line — skip
      }
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) {
    try {
      yield JSON.parse(tail) as unknown;
    } catch {
      // malformed line — skip
    }
  }
}
