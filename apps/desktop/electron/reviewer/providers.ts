/** Provider contracts for the reviewer harness: one shape, three adapters.
 *  The harness talks to models over plain HTTP streaming — no SDKs, so the
 *  whole provider surface is testable with stubbed fetch + fixtures. */

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
   *  message; never re-sent to the model. */
  thinking?: string;
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
  /** Token usage when the provider reports it (streamed or final). */
  usage?: ProviderUsage;
}

export interface ProviderClient {
  readonly name: ProviderName;
  complete(opts: CompleteOpts): Promise<ProviderResult>;
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
