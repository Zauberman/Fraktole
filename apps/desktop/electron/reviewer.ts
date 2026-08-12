import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FraktoleMessage, ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../src/shared/ipc.js';
import { ReviewerTools, type ReviewerToolContext } from './reviewer-tools.js';
import { createProvider, type ProviderClient, type ProviderMsg } from './reviewer/providers.js';
import type { TileRecorder } from './tile-recorder.js';

export type { ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../src/shared/ipc.js';

export interface ReviewerConfig {
  provider: 'openai' | 'anthropic' | 'ollama';
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface ReviewerEmitter {
  status(status: ReviewerStatus, error?: string): void;
  stream(delta: string): void;
  toolCall(ev: ReviewerToolCallEvent): void;
  message(entry: ReviewerEntry): void;
}

export interface ReviewerHostOpts {
  getConfig(): Promise<ReviewerConfig>;
  sessionId: string;
  sessionDir: string;
  cwd: string;
  recorder: TileRecorder;
  toolContext: ReviewerToolContext;
  emit: ReviewerEmitter;
  /** injectable seams for tests */
  createProvider?: (name: string) => ProviderClient;
  tools?: ReviewerTools;
  conversationFile?: string;
  logger?(line: string): void;
}

const MAX_TOOL_ITERATIONS = 25;
const COMPACT_THRESHOLD = 60_000;
const TOOL_RESULT_CHARS = 20_000;

export function buildSystemPrompt(sessionId: string, cwd: string): string {
  return [
    `You are the Fraktole reviewer orchestrator for session ${sessionId}.`,
    `You observe agents through tools (list_tiles, read_tile, read_scrollback), delegate work via`,
    `send_message (kind task|note), and may run_bash/read_file in the project (cwd: ${cwd}).`,
    `Start each engagement by calling list_tiles so you know what is running.`,
    'Read the TAIL of a tile before judging it; use read_scrollback for full history.',
    'Do not send messages to an agent unless the task warrants it.',
    'End each engagement with a concise verdict: what each agent did, and what you recommend.',
  ].join('\n');
}

/**
 * The reviewer harness: our own model loop living in the main process. One
 * continuous conversation per session, persisted as JSONL; the loop runs
 * exclusively, queues triggers (user prompts, agent result messages), and
 * executes tool calls until the model stops requesting them.
 */
export class ReviewerHost {
  status: ReviewerStatus = 'offline';
  private messages: ProviderMsg[] = [];
  private queue: ProviderMsg[] = [];
  private running = false;
  private aborter: AbortController | null = null;
  private provider: ProviderClient;
  private readonly tools: ReviewerTools;
  private readonly conversationFile: string;

  constructor(private readonly opts: ReviewerHostOpts) {
    this.provider = (opts.createProvider ?? createProvider)('anthropic');
    this.tools = opts.tools ?? new ReviewerTools();
    this.conversationFile = opts.conversationFile ?? join(opts.sessionDir, 'reviewer', 'conversation.jsonl');
  }

  get conversation(): ReviewerEntry[] {
    return this.messages.map(toEntry);
  }

  /** Loads the conversation and marks the harness ready. False when the
   *  provider config is unusable (missing API key). */
  async start(): Promise<boolean> {
    const cfg = await this.opts.getConfig();
    const key = await this.apiKeyFor(cfg);
    if (key === null) {
      this.setStatus('unconfigured', 'missing API key — configure the reviewer provider first');
      return false;
    }
    this.provider = (this.opts.createProvider ?? createProvider)(cfg.provider);
    await this.load();
    if (this.messages.length === 0) {
      this.messages.push({ role: 'system', content: buildSystemPrompt(this.opts.sessionId, this.opts.cwd) });
    }
    this.setStatus('running');
    this.drainQueue();
    return true;
  }

  /** Aborts the current run and forgets the conversation. */
  async restart(): Promise<boolean> {
    this.cancel();
    this.messages = [];
    this.queue = [];
    await this.truncateConversation();
    return this.start();
  }

  /** Explicit off switch (session stopped). */
  stop(): void {
    this.cancel();
    this.queue = [];
    this.setStatus('stopped');
  }

  /** Idle shutdown: aborts the run, keeps the conversation for later. */
  idleOut(): void {
    this.cancel();
    this.setStatus('idle');
  }

  /** Queues a user prompt (from the Reviewer tab). */
  async prompt(text: string): Promise<void> {
    if (this.status !== 'running') return;
    this.queue.push({ role: 'user', content: text });
    this.drainQueue();
  }

  /** Queues an agent result message as a turn. */
  onAgentMessage(msg: FraktoleMessage): void {
    if (this.status !== 'running') return;
    this.queue.push({
      role: 'user',
      content: `[${msg.from} → ${msg.to} (${msg.kind})]: ${msg.body}`,
    });
    this.drainQueue();
  }

  /** Aborts the in-flight provider call; queued turns are dropped. */
  cancel(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  private async apiKeyFor(cfg: ReviewerConfig): Promise<string | null> {
    if (cfg.provider === 'ollama') return 'ollama';
    const envName = cfg.apiKeyEnv ?? (cfg.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
    const key = process.env[envName];
    if (!key) return null;
    return key;
  }

  private setStatus(status: ReviewerStatus, error?: string): void {
    this.status = status;
    this.opts.emit.status(status, error);
  }

  private drainQueue(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running || this.status !== 'running') return;
    this.running = true;
    const aborter = new AbortController();
    this.aborter = aborter;
    const cfg = await this.opts.getConfig();
    const apiKey = (await this.apiKeyFor(cfg)) ?? '';
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        this.messages.push(turn);
        await this.persist();
        this.opts.emit.message(toEntry(turn));

        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          const res = await this.provider.complete({
            model: cfg.model,
            apiKey,
            baseUrl: cfg.baseUrl ?? '',
            messages: this.messages,
            tools: this.tools.definitions(),
            signal: aborter.signal,
            onDelta: (delta) => this.opts.emit.stream(delta),
          });
          this.messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
          await this.persist();
          const entry = toEntry(this.messages[this.messages.length - 1]!);
          this.opts.emit.message(entry);

          if (res.toolCalls.length === 0) break;
          let failed = false;
          for (const call of res.toolCalls) {
            const started = Date.now();
            this.opts.emit.toolCall({ name: call.name, args: call.args, state: 'start' });
            const result = await this.tools.run(call.name, call.args, this.opts.toolContext);
            const durationMs = Date.now() - started;
            if (result.startsWith('error:')) {
              failed = true;
              this.opts.emit.toolCall({ name: call.name, args: call.args, state: 'error', error: result, durationMs });
            } else {
              this.opts.emit.toolCall({
                name: call.name,
                args: call.args,
                state: 'done',
                result: result.slice(0, 2000),
                durationMs,
              });
            }
            const capped = result.length > TOOL_RESULT_CHARS ? `${result.slice(0, TOOL_RESULT_CHARS)}\n…[truncated]` : result;
            this.messages.push({ role: 'tool', content: capped, toolCallId: call.id });
            this.opts.emit.message(toEntry(this.messages[this.messages.length - 1]!));
          }
          await this.persist();
          if (failed) break; // don't spin on a broken tool
        }
        this.compactIfNeeded();
      }
    } catch (err) {
      if (!aborter.signal.aborted) {
        this.setStatus('error', (err as Error).message);
      }
    } finally {
      this.running = false;
      this.aborter = null;
    }
  }

  /** Drops old tool rows when the conversation outgrows the budget. */
  private compactIfNeeded(): void {
    let total = 0;
    for (const m of this.messages) total += m.content.length;
    if (total <= COMPACT_THRESHOLD) return;
    let dropped = 0;
    while (this.messages.length > 4 && total > COMPACT_THRESHOLD) {
      const victim = this.messages[1]!;
      total -= victim.content.length;
      this.messages.splice(1, 1);
      dropped += 1;
    }
    if (dropped > 0) {
      const note: ProviderMsg = { role: 'system', content: `[context compacted: ${dropped} old exchanges dropped]` };
      this.messages.splice(1, 0, note);
      this.opts.emit.message(toEntry(note));
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.conversationFile, 'utf8');
    } catch {
      return;
    }
    const loaded: ProviderMsg[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        loaded.push(JSON.parse(line) as ProviderMsg);
      } catch {
        // a corrupt line must not hide the rest
      }
    }
    this.messages = loaded;
  }

  private async persist(): Promise<void> {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      await appendFile(this.conversationFile, `${JSON.stringify(last)}\n`, 'utf8');
    } catch (err) {
      this.opts.logger?.(`reviewer: persist failed (${(err as Error).message})`);
    }
  }

  private async truncateConversation(): Promise<void> {
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      const fs = await import('node:fs/promises');
      await fs.truncate(this.conversationFile);
    } catch {
      // nothing to clear
    }
  }
}

function toEntry(msg: ProviderMsg): ReviewerEntry {
  return {
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls,
    toolCallId: msg.toolCallId,
    at: Date.now(),
  };
}
