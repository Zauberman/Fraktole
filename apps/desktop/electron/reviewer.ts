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
  ReviewerUsageEvent,
} from '../src/shared/ipc.js';
import { resolveProvider, type ProviderResolution } from '../src/shared/reviewer-detect.js';
import { sanitizeChatText } from '../src/shared/sanitize.js';
import { ORCHESTRATOR_ID } from './mailbox.js';
import { ReviewerTools, type ReviewerToolContext } from './reviewer-tools.js';
import { emptyState, isGoalMet, loadState, persistState } from './reviewer-state.js';
import { createProvider, type ProviderClient, type ProviderMsg, type ProviderResult } from './reviewer/providers.js';
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
  /** Reasoning effort (deepseek/openai); empty = auto. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/** Smart default: 'high' on official DeepSeek/OpenAI endpoints (they accept
 *  reasoning_effort), omitted for custom baseUrls where unknown params can
 *  400. */
export function defaultReasoningEffort(res: ProviderResolution): 'high' | undefined {
  const u = res.baseUrl.toLowerCase();
  return u.includes('api.deepseek.com') || u.includes('api.openai.com') ? 'high' : undefined;
}

export interface ReviewerEmitter {
  status(status: ReviewerStatus, error?: string, model?: string): void;
  stream(ev: ReviewerStreamEvent): void;
  toolCall(ev: ReviewerToolCallEvent): void;
  message(entry: ReviewerEntry): void;
  goal(ev: ReviewerGoalEvent): void;
  question(ev: ReviewerQuestion): void;
  /** Cumulative usage totals after a completed turn. */
  usage(ev: ReviewerUsageEvent): void;
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
  /** Retry policy for transient provider failures: one retry after 2s by
   *  default — a network blip must not kill the harness. Injectable for
   *  tests. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Override the per-model context budget (tokens) used by compaction. */
  contextBudgetTokens?: number;
  /** injectable seams for tests */
  createProvider?: (name: string) => ProviderClient;
  tools?: ReviewerTools;
  conversationFile?: string;
  stateFile?: string;
  logger?(line: string): void;
}

const MAX_TOOL_ITERATIONS = 25;
const TOOL_RESULT_CHARS = 20_000;
const POLL_INTERVAL_MS_DEFAULT = 30_000;
const MAX_COMPLETE_RETRIES = 1;
const COMPLETE_RETRY_DELAY_MS = 2_000;

/** Per-model context budgets (tokens) — compaction keeps the conversation
 *  within 80% of the budget. Unknown openai-compatible models default to
 *  128K. */
const CONTEXT_BUDGETS: Array<[string, number]> = [
  ['claude', 200_000],
  ['gpt-4o', 128_000],
  ['deepseek', 128_000],
  ['qwen2.5', 32_000],
];

function contextBudgetTokens(model: string, override?: number): number {
  if (override !== undefined) return override;
  const m = model.toLowerCase();
  for (const [prefix, tokens] of CONTEXT_BUDGETS) {
    if (m.includes(prefix)) return tokens;
  }
  return 128_000;
}
/** With an active goal, force a wake every N silent polls (5 min at 30s) so
 *  a stalled loop can never die quietly. */
const GOAL_RECHECK_POLLS = 10;

export function buildSystemPrompt(sessionId: string, cwd: string): string {
  return [
    `You are the Fraktole reviewer orchestrator for session ${sessionId}. You lead a workforce of agent terminals and you are accountable for the quality of what it ships. Project root: ${cwd}.`,
    '',
    'OPERATING PROTOCOL',
    '- You are a GENERAL commanding a workforce of agent terminals — and you can shoot too. DELEGATE substantive work by default: building, editing, refactoring, long-running processes go to agents via send_message (spawn_agent first when the workforce is idle or too small).',
    '- But do not outsource everything: use your own hands when it is genuinely faster or clearer — read_file, list_dir, search_files, run_bash to grasp context, verify, or make a small fix yourself. Choose per task: if an agent can carry it well, send it; if a direct look is quicker or deeper, take it.',
    '- Start by calling list_tiles so you know what is running; an idle agent is wasted capacity.',
    '- Read the tail of a tile before judging it; read_scrollback for the persisted history.',
    '- Keep the ledger current: update_task on every assignment (pending/active/done/failed); read_state when unsure.',
    '- Dispatch with precise, verifiable acceptance criteria; the agent\'s result wakes you — then verify, judge, re-dispatch.',
    '',
    'VERIFYING & JUDGING RESULTS',
    '- Never take an agent\'s word for a result. Verify important results: read_tile (tail), search_files (stubs, TODOs, wrong symbols), run_bash (tests, builds), read_test_page (console errors, loading).',
    '- Judge every important result — and its sub-results (builds, tests, pages) — against the goal before accepting it.',
    '- Reject incomplete, wrong or sloppy work: re-dispatch with a specific, actionable correction, not a vague "do better".',
    '- Do not micro-check trivia; spend your scrutiny where correctness matters.',
    '- When a goal is armed (the [goal: ...] block), you are the loop master: dispatch, verify, re-dispatch until the goal is genuinely met, then reply with "GOAL-MET:" and your verdict.',
    '- For destructive or uncertain steps (killing an agent, unknown spawn choices), ask the user first with ask_user.',
    '',
    'REPORTING',
    '- End every engagement with a verdict: what each agent did, what you verified, what you recommend.',
    '- Keep replies tight. ASCII only — never emojis or decorative unicode in any message, body or reply.',
    '- Never set, change or clear the goal yourself — only the user can, via /goal.',
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
  private reasoningEffort: ReviewerConfig['reasoningEffort'] = undefined;
  /** Durable goal + task ledger (survives compaction and restarts). */
  private state: ReviewerState = emptyState();
  private watchTimer: NodeJS.Timeout | null = null;
  /** Per-tile line counts from the last poll (the cheap activity signal). */
  private lastLines = new Map<string, number>();
  private pollsSinceWake = 0;
  /** One in-flight start() shared by concurrent callers (tab visits, rapid
   *  prompts) so the conversation can never be double-loaded. */
  private startPromise: Promise<boolean> | null = null;
  /** How many conversation lines are already on disk (the prefix of
   *  this.messages that has been persisted). */
  private persistedCount = 0;
  /** Per-turn token cost (marginal), oldest first — aligned with the turn
   *  order so compaction can subtract exactly what it drops. */
  private turnTokens: number[] = [];
  /** Total tokens across the whole conversation from the last usage event
   *  (used to derive per-turn marginals when the provider reports usage). */
  private lastUsageTotal = 0;
  /** Marginal tokens of the turn whose usage event just arrived (consumed
   *  by recordTurnCost at the turn boundary). */
  private pendingUsageDelta: number | null = null;
  /** A /compact issued mid-turn: applied at the next turn boundary instead
   *  of splicing the conversation while the model is streaming. */
  private pendingCompact = false;
  /** True when the most recently processed turn was the watchdog's own
   *  compaction wake — used to never chain wakes back-to-back (an
   *  over-budget conversation would otherwise wake forever). */
  private lastTurnWasWake = false;
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
      runBackground: (command, cwd) => this.opts.toolContext.runBackground?.(command, cwd) ?? Promise.resolve('error: background jobs unavailable'),
      jobStatus: (jobId) => this.opts.toolContext.jobStatus?.(jobId) ?? Promise.resolve('error: background jobs unavailable'),
      jobStop: (jobId) => this.opts.toolContext.jobStop?.(jobId) ?? Promise.resolve('error: background jobs unavailable'),
      listMessages: () => this.opts.toolContext.listMessages?.() ?? Promise.resolve([]),
      writeToAgent: (agentId, command) => this.opts.toolContext.writeToAgent?.(agentId, command) ?? Promise.resolve('error: launch unavailable'),
      reloadTestPage: () => this.opts.toolContext.reloadTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
    };
  }

  get conversation(): ReviewerEntry[] {
    return this.messages.map(toEntry);
  }

  /** Resolves provider/endpoint/model from the pasted API key (env fallback
   *  via apiKeyEnv), loads the conversation and marks the harness ready.
   *  False when a non-ollama provider has no key. Reentrant: concurrent
   *  callers share one in-flight start. */
  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<boolean> {
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
    this.reasoningEffort = cfg.reasoningEffort;
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
    if (this.startPromise) {
      const inflight = this.startPromise;
      this.startPromise = null;
      await inflight.catch(() => undefined);
    }
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

  /** Revive path for user interactions: start() unless the user explicitly
   *  stopped the reviewer (the start button owns that case). Never lets a
   *  prompt or a goal silently vanish because the harness was down. */
  private async ensureStarted(): Promise<boolean> {
    if (this.status === 'running') return true;
    if (this.status === 'stopped') return false;
    return this.start();
  }

  /** Queues a user prompt (from the Reviewer tab). Revives the harness
   *  first when it is down (idle/error/offline/unconfigured) so the prompt
   *  is never silently dropped; returns false only when the reviewer is
   *  explicitly stopped or has no API key. */
  async prompt(text: string): Promise<boolean> {
    if (!(await this.ensureStarted())) return false;
    this.queue.push({ role: 'user', content: this.withStateBlock(text) });
    this.drainQueue();
    return true;
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
   *  this (the /goal command); the model never sets its own goal. Revives
   *  the harness when down, like prompt(). */
  async setGoal(text: string | null): Promise<void> {
    if (!(await this.ensureStarted())) return;
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

  /** One transparent retry on provider errors (a network blip must not kill
   *  the harness). Aborts are never retried. */
  private async callWithRetry(signal: AbortSignal, call: () => Promise<ProviderResult>): Promise<ProviderResult> {
    const max = this.opts.maxRetries ?? MAX_COMPLETE_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        if (signal.aborted || attempt >= max) throw err;
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? COMPLETE_RETRY_DELAY_MS));
      }
    }
  }

  /** Manual compaction pass (the /compact command): forces a turn-boundary
   *  compaction now, or defers it to the next turn boundary if the model is
   *  mid-run. */
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
        const turnStart = this.messages.length;
        const turn = this.queue.shift()!;
        this.lastTurnWasWake = typeof turn.content === 'string' && turn.content.includes('context was compacted');
        this.messages.push(turn);
        await this.persist();
        this.opts.emit.message(toEntry(turn));

        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          if (aborter.signal.aborted) break;
          const response = await this.callWithRetry(aborter.signal, () =>
            this.provider.complete({
              model: res.model,
              apiKey: this.apiKey,
              baseUrl: res.baseUrl,
              messages: this.messages,
              tools: this.tools.definitions(),
              signal: aborter.signal,
              reasoningEffort: this.reasoningEffort ?? defaultReasoningEffort(res),
              onDelta: (delta, thinking) =>
                this.opts.emit.stream({
                  delta,
                  thinking: thinking && thinking.length > 0 ? thinking : undefined,
                }),
            }),
          );
          // never persist an empty toolCalls array: providers reject
          // "tool_calls": [] on the next request (OpenAI 400s on it)
          const assistant: ProviderMsg = {
            role: 'assistant',
            content: response.text,
            thinking: response.thinking.length > 0 ? response.thinking : undefined,
          };
          if (response.toolCalls.length > 0) assistant.toolCalls = response.toolCalls;
          this.messages.push(assistant);
          if (response.usage) {
            const total = response.usage.inputTokens + response.usage.cachedTokens + response.usage.outputTokens;
            this.pendingUsageDelta = Math.max(1, total - this.lastUsageTotal);
            this.lastUsageTotal = total;
            this.state.usage.inputTokens += response.usage.inputTokens;
            this.state.usage.cachedTokens += response.usage.cachedTokens;
            this.state.usage.outputTokens += response.usage.outputTokens;
            await persistState(this.stateFile, this.state, this.opts.logger);
            this.opts.emit.usage({ at: Date.now(), ...this.state.usage });
          }
          await this.persist();
          const entry = toEntry(this.messages[this.messages.length - 1]!);
          this.opts.emit.message(entry);

          if (isGoalMet(response.text) && this.state.goal?.state === 'active') {
            this.state.goal.state = 'met';
            await persistState(this.stateFile, this.state, this.opts.logger);
            this.opts.emit.goal({ goal: this.state.goal });
          }

          if (response.toolCalls.length === 0) break;
          for (const call of response.toolCalls) {
            // a cancel (restart/stop/idle) must end the turn promptly —
            // the in-flight tool's rejection is a normal error result
            if (aborter.signal.aborted) break;
            const started = Date.now();
            this.opts.emit.toolCall({ callId: call.id, name: call.name, args: call.args, state: 'start', at: Date.now() });
            const result = await this.tools.run(call.name, call.args, this.toolContext);
            const durationMs = Date.now() - started;
            if (result.startsWith('error:')) {
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
          // A failed tool must NOT end the turn: the error result is in the
          // model's context, and it decides whether to retry, adapt or
          // reply. MAX_TOOL_ITERATIONS still bounds runaway retries.
          await this.persist();
        }
        this.recordTurnCost(turnStart);
        this.compactIfNeeded(false, true);
      }
    } catch (err) {
      if (!aborter.signal.aborted) {
        this.setStatus('error', (err as Error).message);
      }
    } finally {
      this.running = false;
      this.aborter = null;
      // a /compact deferred mid-turn lands here when the run ends early
      // (abort/error) without reaching the turn-boundary call
      if (this.pendingCompact) this.compactIfNeeded(false, true);
    }
  }

  /** Records the token cost of the turn that just finished (messages from
   *  `turnStart` onward). Uses the provider's real usage marginal when
   *  available (set by recordUsage, Phase 2); falls back to chars/4. */
  private recordTurnCost(turnStart: number): void {
    if (this.lastUsageTotal > 0 && this.pendingUsageDelta !== null) {
      this.turnTokens.push(Math.max(1, this.pendingUsageDelta));
      this.pendingUsageDelta = null;
      return;
    }
    let chars = 0;
    for (let i = turnStart; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      chars += m.content.length + (m.thinking?.length ?? 0);
    }
    this.turnTokens.push(Math.max(1, Math.ceil(chars / 4)));
  }

  /** Estimated total tokens currently in the conversation. */
  private estimateTokens(): number {
    let total = 400; // system prompt constant
    for (const t of this.turnTokens) total += t;
    return total;
  }

  /** Drops whole oldest turns while the conversation exceeds 80% of the
   *  model's context budget (or on a forced /compact pass). Turns are
   *  removed as complete units — an assistant's tool responses can never be
   *  orphaned, so the conversation stays API-valid at every step. The two
   *  newest turns are always kept. A /compact issued mid-turn is deferred to
   *  the next turn boundary. */
  private compactIfNeeded(force = false, atBoundary = false): void {
    if (this.running && !atBoundary) {
      if (force) this.pendingCompact = true;
      return;
    }
    const doForce = force || this.pendingCompact;
    this.pendingCompact = false;
    const budget = Math.floor(contextBudgetTokens(this.resolved?.model ?? '', this.opts.contextBudgetTokens) * 0.8);
    let dropped = 0;
    for (;;) {
      const userIdx: number[] = [];
      this.messages.forEach((m, i) => {
        if (m.role === 'user') userIdx.push(i);
      });
      if (userIdx.length <= 2) break;
      if (!doForce && this.estimateTokens() <= budget) break;
      const start = userIdx[0]!;
      const end = userIdx[1]!;
      this.messages.splice(start, end - start);
      this.turnTokens.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      // role user + position after the first user turn: the note joins the
      // oldest kept turn's content and never looks like a second system
      const note: ProviderMsg = {
        role: 'user',
        content: `[context compacted: ${dropped} exchanges dropped — your goal and ledger are unchanged; continue]`,
      };
      this.messages.splice(2, 0, note);
      this.opts.emit.message(toEntry(note));
      // every surviving message (except the transient note, which stays
      // memory-only) is already on disk — re-sync the write cursor so the
      // turns after a compaction are never skipped
      this.persistedCount = this.messages.length;
      if (this.state.goal?.state === 'active' && !this.lastTurnWasWake) {
        this.queue.push({ role: 'user', content: this.withStateBlock('[watchdog] context was compacted — re-check progress') });
        this.drainQueue();
      }
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
        const msg = JSON.parse(line) as ProviderMsg;
        // heal legacy history: providers reject empty toolCalls arrays
        if (msg.toolCalls && msg.toolCalls.length === 0) msg.toolCalls = undefined;
        loaded.push(msg);
      } catch {
        // a corrupt line must not hide the rest
      }
    }
    this.persistedCount = loaded.length;
    this.messages = this.repairSequence(loaded);
    // the surviving messages are all already on disk (repair only drops);
    // re-sync the write cursor so post-load turns persist immediately
    this.persistedCount = this.messages.length;
  }

  /** Drops structurally-broken turns from a loaded conversation: an
   *  assistant message whose tool_calls lack their tool responses (a crash
   *  or an old build that persisted only the last result) would be rejected
   *  by every provider. Orphan tool messages go with it. A window is kept
   *  only on an EXACT match — every response must belong to a call and every
   *  call must be answered, so extra responses can never leak into a
   *  request. */
  private repairSequence(msgs: ProviderMsg[]): ProviderMsg[] {
    const out: ProviderMsg[] = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i]!;
      if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? []).map((c) => c.id).sort();
        const responses: string[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j]!.role === 'tool') {
          if (msgs[j]!.toolCallId) responses.push(msgs[j]!.toolCallId!);
          j += 1;
        }
        responses.sort();
        const exact =
          (calls.length === 0 && responses.length === 0) ||
          (calls.length === responses.length && calls.every((id, k) => id === responses[k]!));
        if (exact) {
          out.push(m);
          for (let k = i + 1; k < j; k++) out.push(msgs[k]!);
        }
        i = j;
      } else if (m.role === 'tool') {
        // orphan tool result — no assistant owner kept
        i += 1;
      } else {
        out.push(m);
        i += 1;
      }
    }
    return out;
  }

  /** Appends every not-yet-persisted message (never just the last one — a
   *  multi-call turn's tool results must all survive a restart). The system
   *  prompt is memory-only, as before. */
  private async persist(): Promise<void> {
    if (this.persistedCount >= this.messages.length) return;
    const fresh = this.messages.slice(this.persistedCount);
    const lines = fresh.filter((m) => m.role !== 'system').map((m) => JSON.stringify(m));
    this.persistedCount = this.messages.length;
    if (lines.length === 0) return;
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      await appendFile(this.conversationFile, `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
      this.opts.logger?.(`reviewer: persist failed (${(err as Error).message})`);
    }
  }

  private async truncateConversation(): Promise<void> {
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      const fs = await import('node:fs/promises');
      await fs.truncate(this.conversationFile);
      this.persistedCount = 0;
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
