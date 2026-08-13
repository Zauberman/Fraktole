import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  FraktoleMessage,
  ReviewerEntry,
  ReviewerGoalEvent,
  ReviewerQuestion,
  ReviewerState,
  ReviewerStatus,
  ReviewerStreamEvent,
  ReviewerTask,
  ReviewerToolCallEvent,
} from '../src/shared/ipc.js';
import { resolveProvider, type ProviderResolution } from '../src/shared/reviewer-detect.js';
import { sanitizeChatText } from '../src/shared/sanitize.js';
import { ORCHESTRATOR_ID } from './mailbox.js';
import { ReviewerTools, type ReviewerToolContext } from './reviewer-tools.js';
import { emptyState, isGoalMet, loadState, persistState } from './reviewer-state.js';
import { createProvider, type ProviderClient, type ProviderMsg } from './reviewer/providers.js';
import type { TileRecorder } from './tile-recorder.js';

export type { ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../src/shared/ipc.js';

export interface ReviewerConfig {
  /** Pasted API key — everything else is derived from it. */
  apiKey?: string;
  /** Env-var fallback when apiKey is empty. */
  apiKeyEnv?: string;
  /** Explicit pick for ambiguous sk- keys. */
  provider?: 'openai' | 'anthropic' | 'ollama' | 'deepseek';
  /** User's model pick; empty → per-provider default. */
  model?: string;
  /** Custom OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Launcher command for reviewer-spawned agent tiles ('' = ask the user). */
  agentCommand?: string;
}

export interface ReviewerEmitter {
  status(status: ReviewerStatus, error?: string, model?: string): void;
  stream(ev: ReviewerStreamEvent): void;
  toolCall(ev: ReviewerToolCallEvent): void;
  message(entry: ReviewerEntry): void;
  goal(ev: ReviewerGoalEvent): void;
  question(ev: ReviewerQuestion): void;
}

export interface ReviewerHostOpts {
  getConfig(): Promise<ReviewerConfig>;
  sessionId: string;
  sessionDir: string;
  cwd: string;
  recorder: TileRecorder;
  toolContext: ReviewerToolContext;
  emit: ReviewerEmitter;
  /** Watchdog poll interval; injectable for tests. */
  pollIntervalMs?: number;
  /** injectable seams for tests */
  createProvider?: (name: string) => ProviderClient;
  tools?: ReviewerTools;
  conversationFile?: string;
  stateFile?: string;
  logger?(line: string): void;
}

const MAX_TOOL_ITERATIONS = 25;
const COMPACT_THRESHOLD = 60_000;
const TOOL_RESULT_CHARS = 20_000;
const POLL_INTERVAL_MS_DEFAULT = 30_000;
/** With an active goal, force a wake every N silent polls (5 min at 30s) so
 *  a stalled loop can never die quietly. */
const GOAL_RECHECK_POLLS = 10;

export function buildSystemPrompt(sessionId: string, cwd: string): string {
  return [
    `You are the Fraktole reviewer orchestrator for session ${sessionId}.`,
    `You observe agents through tools (list_tiles, read_tile, read_scrollback), delegate work via`,
    `send_message (kind task|note), and may run_bash/read_file in the project (cwd: ${cwd}).`,
    `Start each engagement by calling list_tiles so you know what is running.`,
    'Read the TAIL of a tile before judging it; use read_scrollback for full history.',
    'Do not send messages to an agent unless the task warrants it.',
    'Never use emojis or decorative unicode in any message, body or reply — ASCII only.',
    'Context compacts automatically near the limit; keep replies tight.',
    'End each engagement with a concise verdict: what each agent did, and what you recommend.',
    'When a goal is armed (you receive the [goal: ...] block), you are the loop master:',
    'keep read_state current, record every assignment in the ledger with update_task',
    '(pending/active/done/failed), dispatch work via send_message to idle agents,',
    'verify results with read_tile, and iterate — re-dispatch, re-check — until the goal is met.',
    'When you judge the goal fully met, start your final message with "GOAL-MET:" followed by your verdict.',
    'Never set, change or clear the goal yourself — only the user can, via /goal.',
    'When an agent reports a working dev server or built page, open it in the Test tab',
    'with open_test_page and verify it with read_test_page (loading flag, console errors).',
    'screenshot_test_page saves a picture for the user — it cannot be seen by you.',
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
  /** Provider/endpoint/model resolved from the key at start(). */
  private resolved: ProviderResolution | null = null;
  private apiKey = '';
  private readonly tools: ReviewerTools;
  private readonly conversationFile: string;
  private readonly stateFile: string;
  private agentCommand = '';
  /** Durable goal + task ledger (survives compaction and restarts). */
  private state: ReviewerState = emptyState();
  private watchTimer: NodeJS.Timeout | null = null;
  /** Per-tile line counts from the last poll (the cheap activity signal). */
  private lastLines = new Map<string, number>();
  private pollsSinceWake = 0;
  /** The in-flight ask_user question; the tool promise resolves on the
   *  user's answer (or rejects on restart/stop). At most one — the loop is
   *  exclusive. */
  private pendingAsk: {
    askId: string;
    kind: ReviewerQuestion['kind'];
    agentId?: string;
    resolve(v: string): void;
    reject(e: Error): void;
  } | null = null;
  private askSeq = 0;
  /** Single-use kill grants per agent, earned from confirm-kill "yes". */
  private killGrants = new Set<string>();
  /** Tool context merged with the ledger callbacks (state lives here). */
  private readonly toolContext: ReviewerToolContext;

  constructor(private readonly opts: ReviewerHostOpts) {
    this.provider = (opts.createProvider ?? createProvider)('anthropic');
    this.tools = opts.tools ?? new ReviewerTools();
    this.conversationFile = opts.conversationFile ?? join(opts.sessionDir, 'reviewer', 'conversation.jsonl');
    this.stateFile = opts.stateFile ?? join(opts.sessionDir, 'reviewer', 'state.json');
    this.toolContext = {
      ...opts.toolContext,
      getState: () => this.state,
      updateTask: (task) => this.updateTask(task),
      askUser: (question, kind, agentId) => this.askUser(question, kind, agentId),
      tryKillAgent: (agentId) => this.tryKillAgent(agentId),
      getAgentCommand: () => this.agentCommand,
      agentCount: () => this.agentCount(),
      spawnAgent: (kind, cwd) => this.spawnAgent(kind, cwd),
      setGoal: (text) => this.setGoal(text.length > 0 ? text : null),
      openTestPage: (url) => this.opts.toolContext.openTestPage?.(url) ?? Promise.resolve('error: test tab unavailable'),
      readTestPage: () => this.opts.toolContext.readTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
      screenshotTestPage: () => this.opts.toolContext.screenshotTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
    };
  }

  get conversation(): ReviewerEntry[] {
    return this.messages.map(toEntry);
  }

  /** Resolves provider/endpoint/model from the pasted API key (env fallback
   *  via apiKeyEnv), loads the conversation and marks the harness ready.
   *  False when a non-ollama provider has no key. */
  async start(): Promise<boolean> {
    const cfg = await this.opts.getConfig();
    const key = cfg.apiKey?.trim() ?? (cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? '') : '');
    const res = resolveProvider(key, {
      baseUrl: cfg.baseUrl,
      providerHint: cfg.provider,
      modelHint: cfg.model,
    });
    if (res.adapter !== 'ollama' && key.length === 0) {
      this.setStatus('unconfigured', 'no API key — paste one in the reviewer config');
      return false;
    }
    this.resolved = res;
    this.apiKey = key;
    this.agentCommand = cfg.agentCommand?.trim() ?? '';
    this.provider = (this.opts.createProvider ?? createProvider)(res.adapter);
    await this.load();
    if (this.messages.length === 0) {
      this.messages.push({ role: 'system', content: buildSystemPrompt(this.opts.sessionId, this.opts.cwd) });
    }
    this.state = await loadState(this.stateFile);
    this.pollsSinceWake = 0;
    this.startWatch();
    this.setStatus('running');
    this.drainQueue();
    return true;
  }

  /** Aborts the current run and forgets the conversation (and the goal and
   *  task ledger — a true reset of the reviewer). */
  async restart(): Promise<boolean> {
    this.cancel();
    this.stopWatch();
    this.rejectPendingAsk();
    this.messages = [];
    this.queue = [];
    this.state = emptyState();
    await this.truncateConversation();
    await persistState(this.stateFile, this.state, this.opts.logger);
    this.opts.emit.goal({ goal: null });
    return this.start();
  }

  /** Explicit off switch (session stopped). */
  stop(): void {
    this.cancel();
    this.stopWatch();
    this.rejectPendingAsk();
    this.queue = [];
    this.setStatus('stopped');
  }

  /** Idle shutdown: aborts the run, stops the watchdog, keeps the
   *  conversation and ledger for later. */
  idleOut(): void {
    this.cancel();
    this.stopWatch();
    this.rejectPendingAsk();
    this.setStatus('idle');
  }

  /** Queues a user prompt (from the Reviewer tab). */
  async prompt(text: string): Promise<void> {
    if (this.status !== 'running') return;
    this.queue.push({ role: 'user', content: this.withStateBlock(text) });
    this.drainQueue();
  }

  /** Queues an agent result message as a turn. The body is sanitized at
   *  ingestion so the model never sees (or echoes) emoji. */
  onAgentMessage(msg: FraktoleMessage): void {
    if (this.status !== 'running') return;
    this.queue.push({
      role: 'user',
      content: this.withStateBlock(`[${msg.from} → ${msg.to} (${msg.kind})]: ${sanitizeChatText(msg.body)}`),
    });
    this.drainQueue();
  }

  /** Arms (text) or disarms (null) the watchdog goal. Only the user can call
   *  this (the /goal command); the model never sets its own goal. */
  async setGoal(text: string | null): Promise<void> {
    if (this.status !== 'running') return;
    const prev = this.state.goal;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const goal = trimmed.length > 0 ? { text: trimmed, setAt: Date.now(), state: 'active' as const } : null;
    this.state.goal = goal;
    this.pollsSinceWake = 0;
    this.lastLines = new Map([...this.opts.recorder.list()].map(([id, s]) => [id, s.lines]));
    await persistState(this.stateFile, this.state, this.opts.logger);
    this.opts.emit.goal({ goal });
    if (goal && (!prev || prev.state !== 'active')) {
      this.queue.push({ role: 'user', content: this.withStateBlock(`[goal armed] ${goal.text}`) });
      this.drainQueue();
    }
  }

  /** Watchdog tick: cheap activity check (line counts only — no model call
   *  unless something wakes the loop). Silent without an active goal. */
  pollNow(): void {
    if (this.status !== 'running') return;
    const lines = new Map<string, number>();
    for (const [tileId, summary] of this.opts.recorder.list()) lines.set(tileId, summary.lines);
    const goal = this.state.goal;
    const quiet = !goal || goal.state === 'met' || this.running || this.queue.length > 0;
    if (quiet) {
      this.lastLines = lines;
      return;
    }
    const delta = [...lines].some(([id, n]) => (this.lastLines.get(id) ?? 0) !== n);
    this.pollsSinceWake += 1;
    if (delta || this.pollsSinceWake >= GOAL_RECHECK_POLLS) {
      this.pollsSinceWake = 0;
      this.queue.push({ role: 'user', content: this.withStateBlock('[watchdog] re-check progress') });
      this.drainQueue();
    }
    this.lastLines = lines;
  }

  /** Ledger upsert: the tools route here; persistence never throws. */
  private async updateTask(task: ReviewerTask): Promise<void> {
    const idx = this.state.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      this.state.tasks[idx] = task;
    } else {
      this.state.tasks.push(task);
    }
    await persistState(this.stateFile, this.state, this.opts.logger);
  }

  /** Suspends the current tool run until the user answers the question
   *  card (answerQuestion) — or rejects on restart/stop. The loop is
   *  exclusive, so only one question can ever be pending. */
  private askUser(question: string, kind: ReviewerQuestion['kind'], agentId?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.pendingAsk) {
        reject(new Error('another question is already pending'));
        return;
      }
      this.askSeq += 1;
      const ask = {
        askId: `q-${Date.now()}-${this.askSeq}`,
        kind,
        agentId,
        resolve,
        reject,
      };
      this.pendingAsk = ask;
      this.opts.emit.question({ askId: ask.askId, question, kind, agentId, at: Date.now() });
    });
  }

  /** Resolves the pending question with the user's answer (from the UI). A
   *  "yes" to a confirm-kill question grants one kill of that agent. */
  answerQuestion(askId: string, answer: string): void {
    const pending = this.pendingAsk;
    if (!pending || pending.askId !== askId) return;
    this.pendingAsk = null;
    if (pending.kind === 'confirm-kill' && pending.agentId && /^yes\b/i.test(answer.trim())) {
      this.killGrants.add(pending.agentId);
    }
    pending.resolve(answer);
  }

  private rejectPendingAsk(): void {
    const pending = this.pendingAsk;
    if (!pending) return;
    this.pendingAsk = null;
    pending.reject(new Error('question cancelled'));
  }

  /** User-commanded kill (/kill <id>): no grant needed — the user is the
   *  authority. Never touches the orchestrator. */
  async killAgentNow(agentId: string): Promise<string> {
    return this.killById(agentId, false);
  }

  /** Model kill path: single-use grant per agent (from confirm-kill "yes").
   *  Without a grant the tool is told to ask the user first. */
  private async tryKillAgent(agentId: string): Promise<string> {
    return this.killById(agentId, true);
  }

  private async killById(agentId: string, grantRequired: boolean): Promise<string> {
    if (agentId === ORCHESTRATOR_ID) return 'error: the orchestrator is not an agent tile';
    if (grantRequired && !this.killGrants.delete(agentId)) {
      return `error: no kill grant for ${agentId} — ask the user first (ask_user, kind confirm-kill)`;
    }
    const tileId = this.opts.toolContext.tileOfAgent(agentId);
    if (!tileId) return `error: unknown agent ${agentId}`;
    return (await this.opts.toolContext.killAgent?.(tileId)) ?? 'error: kill unavailable';
  }

  /** Routes a reviewer spawn to main (which allocates the agent id and asks
   *  the renderer to mount the tile). On success the chosen kind becomes
   *  the durable default so the next spawn can skip the question. */
  private async spawnAgent(kind: string, cwd: string): Promise<string> {
    const result = (await this.opts.toolContext.spawnAgent?.(kind, cwd)) ?? 'error: spawn unavailable';
    if (!result.startsWith('error:') && kind.length > 0 && this.state.lastAgentKind !== kind) {
      this.state.lastAgentKind = kind;
      await persistState(this.stateFile, this.state, this.opts.logger);
    }
    return result;
  }

  /** Live agent tile count (the spawn cap reads this). */
  private agentCount(): number {
    return this.opts.toolContext.agentCount?.() ?? 0;
  }

  /** While a goal is armed, every trigger carries a compact state block so
   *  auto-compaction can never erase what the loop is working on. */
  private withStateBlock(content: string): string {
    const goal = this.state.goal;
    if (!goal) return content;
    const pending = this.state.tasks.filter((t) => t.status === 'pending').length;
    const done = this.state.tasks.filter((t) => t.status === 'done').length;
    return `[goal: ${goal.text} (${goal.state})] [tasks: ${pending} pending, ${done} done] ${content}`;
  }

  private startWatch(): void {
    this.stopWatch();
    this.watchTimer = setInterval(() => this.pollNow(), this.opts.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT);
    this.watchTimer.unref();
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** Manual compaction pass (the /compact command): drops old tool rows
   *  regardless of the size budget and tells the model context was trimmed. */
  compact(): void {
    this.compactIfNeeded(true);
  }

  /** Aborts the in-flight provider call; queued turns are dropped. */
  cancel(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  private setStatus(status: ReviewerStatus, error?: string): void {
    this.status = status;
    this.opts.emit.status(status, error, this.resolved?.model);
  }

  private drainQueue(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running || this.status !== 'running') return;
    this.running = true;
    const aborter = new AbortController();
    this.aborter = aborter;
    const res = this.resolved;
    if (!res) {
      this.running = false;
      return;
    }
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        this.messages.push(turn);
        await this.persist();
        this.opts.emit.message(toEntry(turn));

        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          const response = await this.provider.complete({
            model: res.model,
            apiKey: this.apiKey,
            baseUrl: res.baseUrl,
            messages: this.messages,
            tools: this.tools.definitions(),
            signal: aborter.signal,
            onDelta: (delta, thinking) =>
              this.opts.emit.stream({
                delta,
                thinking: thinking && thinking.length > 0 ? thinking : undefined,
              }),
          });
          this.messages.push({
            role: 'assistant',
            content: response.text,
            toolCalls: response.toolCalls,
            thinking: response.thinking.length > 0 ? response.thinking : undefined,
          });
          await this.persist();
          const entry = toEntry(this.messages[this.messages.length - 1]!);
          this.opts.emit.message(entry);

          if (isGoalMet(response.text) && this.state.goal?.state === 'active') {
            this.state.goal.state = 'met';
            await persistState(this.stateFile, this.state, this.opts.logger);
            this.opts.emit.goal({ goal: this.state.goal });
          }

          if (response.toolCalls.length === 0) break;
          let failed = false;
          for (const call of response.toolCalls) {
            const started = Date.now();
            this.opts.emit.toolCall({ callId: call.id, name: call.name, args: call.args, state: 'start', at: Date.now() });
            const result = await this.tools.run(call.name, call.args, this.toolContext);
            const durationMs = Date.now() - started;
            if (result.startsWith('error:')) {
              failed = true;
              this.opts.emit.toolCall({ callId: call.id, name: call.name, args: call.args, state: 'error', error: result, durationMs, at: Date.now() });
            } else {
              this.opts.emit.toolCall({
                callId: call.id,
                name: call.name,
                args: call.args,
                state: 'done',
                result: result.slice(0, 2000),
                durationMs,
                at: Date.now(),
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

  /** Drops old tool rows when the conversation outgrows the budget (or on a
   *  forced /compact pass). Auto-compaction drops oldest-first; a forced
   *  pass never drops the most recent user turn. */
  private compactIfNeeded(force = false): void {
    let total = 0;
    for (const m of this.messages) total += m.content.length + (m.thinking?.length ?? 0);
    if (!force && total <= COMPACT_THRESHOLD) return;
    let stopAt = Number.MAX_SAFE_INTEGER;
    if (force) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i]!.role === 'user') {
          stopAt = i;
          break;
        }
      }
    }
    let dropped = 0;
    while (this.messages.length > 4 && 1 < stopAt && (force || total > COMPACT_THRESHOLD)) {
      const victim = this.messages[1]!;
      total -= victim.content.length + (victim.thinking?.length ?? 0);
      this.messages.splice(1, 1);
      stopAt -= 1;
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
    thinking: msg.thinking,
    at: Date.now(),
  };
}
