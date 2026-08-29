import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  FraktoleMessage,
  ReviewerEntry,
  ReviewerGoal,
  ReviewerGoalEvent,
  ReviewerQuestion,
  ReviewerState,
  ReviewerStatus,
  ReviewerStreamEvent,
  ReviewerTask,
  ReviewerToolCallEvent,
  ReviewerUsageEvent,
} from '../src/shared/ipc.js';
import { resolveReviewerConfig, type ConfigResolution, type ProviderResolution } from '../src/shared/reviewer-detect.js';
import { sanitizeChatText } from '../src/shared/sanitize.js';
import { ORCHESTRATOR_ID } from './mailbox.js';
import { ReviewerTools, type ReviewerToolContext } from './reviewer-tools.js';
import { AUTONOMY_MISSIONS, AUTONOMY_PLUGINS, type AutonomyVariant } from './reviewer-plugins.js';
import { forkExists, type ForkResult } from './fork.js';
import { emptyState, isGoalMet, loadState, persistState } from './reviewer-state.js';
import { createProvider, type ProviderClient, type ProviderMsg, type ProviderResult, type SamplerKnobs } from './reviewer/providers.js';
import { probeLocalServer, type ProbeFn } from './reviewer/local-probe.js';
import type { TileRecorder } from './tile-recorder.js';

export type { ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../src/shared/ipc.js';

export interface ReviewerConfig {
  /** Pasted API key — everything else is derived from it. */
  apiKey?: string;
  /** Env-var fallback when apiKey is empty. */
  apiKeyEnv?: string;
  /** The manual provider pick (provider-catalog.ts id) — wins when set. */
  providerId?: string;
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
  /** Model-tuning knobs (context window, output cap, samplers); unset =
   *  provider defaults. Captured at start(); applies on restart. */
  knobs?: SamplerKnobs;
  /** The user's custom autonomous loop (name + full directive). */
  customAutonomy?: { name?: string; prompt?: string };
}

/** Smart default: 'high' on official DeepSeek/OpenAI endpoints (they accept
 *  reasoning_effort), omitted for custom baseUrls where unknown params can
 *  400. The hostname match is exact — a proxy whose URL merely contains
 *  "api.openai.com" must not receive it. */
export function defaultReasoningEffort(res: ProviderResolution): 'high' | undefined {
  try {
    const host = new URL(res.baseUrl).hostname;
    return host === 'api.deepseek.com' || host === 'api.openai.com' ? 'high' : undefined;
  } catch {
    return undefined;
  }
}

export interface ReviewerEmitter {
  status(status: ReviewerStatus, error?: string, model?: string, variant?: AutonomyVariant | null): void;
  stream(ev: ReviewerStreamEvent): void;
  toolCall(ev: ReviewerToolCallEvent): void;
  message(entry: ReviewerEntry): void;
  goal(ev: ReviewerGoalEvent): void;
  question(ev: ReviewerQuestion): void;
  /** Cumulative usage totals after a completed turn. */
  usage(ev: ReviewerUsageEvent): void;
  /** A persisted session recap, emitted when a summarize pass completes. */
  recap?(recap: { text: string; at: number }): void;
  /** The resolved context budget for the current provider (after probing a
   *  local server), emitted at start so the UI can show it. */
  budget?(info: { contextTokens: number; probed?: number }): void;
  /** The error of the previous run, resurfaced at load so a dead local loop
   *  never dies silently twice. */
  prevError?(message: string): void;
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
  /** Ask user timeout: how long to wait for a user answer before timing out
   *  (default 10 minutes). Injectable for tests. */
  askTimeoutMs?: number;
  /** Retry policy for transient provider failures: one retry after 2s by
   *  default — a network blip must not kill the harness. Injectable for
   *  tests. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Stream-silence threshold: no provider output for this long aborts and
   *  retries the call (default 120s). */
  stallTimeoutMs?: number;
  /** Wait cycle while a local server is still loading its model (503
   *  "Loading model"): default 15s × 10 attempts (injectable for tests). */
  loadingRetryMs?: number;
  /** Override the per-model context budget (tokens) used by compaction. */
  contextBudgetTokens?: number;
  /** Injectable local-server probe (tests stub this; production probes via
   *  probeLocalServer). */
  probe?: ProbeFn;
  /** Fork the project for an autonomous run; wired by main. keepExisting
   *  preserves a non-empty prior fork (resume-in-place) instead of wiping it. */
  forkProject?: (variant: AutonomyVariant, keepExisting: boolean) => Promise<ForkResult>;
  /** injectable seams for tests */
  createProvider?: (name: string) => ProviderClient;
  tools?: ReviewerTools;
  conversationFile?: string;
  stateFile?: string;
  logger?(line: string): void;
}

const MAX_TOOL_ITERATIONS = 25;
const TOOL_RESULT_CHARS = 20_000;
/** Watchdog poll cadence: cheap line-count checks every 15s. */
const POLL_INTERVAL_MS_DEFAULT = 15_000;
const MAX_COMPLETE_RETRIES = 1;
const COMPLETE_RETRY_DELAY_MS = 2_000;
/** A provider stream that produces NO output (deltas or thinking) for this
 *  long is considered stalled — the call is aborted and retried, then the
 *  harness surfaces it and the watchdog heals the loop. */
const STALL_TIMEOUT_MS = 120_000;
/** While a local server is still loading its model (503 "Loading model"),
 *  wait patiently instead of erroring: 10 tries × 15s ≈ 2.5 minutes for a
 *  multi-GB cold load (a 25GB MoE from NTFS takes ~6 min — the watchdog
 *  revives after that, and the stall path stays error-free meanwhile). */
const LOADING_RETRY_MS = 15_000;
const LOADING_MAX_ATTEMPTS = 10;
/** Conservative fallback context budget for local servers whose window the
 *  harness could not probe and the user did not declare — the days of
 *  assuming 128K for `local-model` are over. */
const LOCAL_DEFAULT_BUDGET = 8_192;
/** Tokens reserved so prompt + max_tokens never overrun the real context. */
const MAX_TOKENS_RESERVE = 512;
/** Bounded auto-heal: how many "continue where you left off" prompts a
 *  single queued turn may spend. */
const HEAL_PROMPTS_MAX = 2;
/** A watchdog wake that finished without touching the goal/task ledger N
 *  times in a row stands down (a stalled loop must not fill the context
 *  forever with re-checks that change nothing). */
const STALE_WAKE_LIMIT = 3;

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

/** True when the harness talks to a keyless local server (ollama or a local
 *  OpenAI-compatible gateway) — these are exactly the servers whose real
 *  context window is declared at LAUNCH time and must be probed. */
function isLocalResolution(res: ConfigResolution): boolean {
  return res.adapter === 'ollama' || (res.entry !== undefined && res.entry.auth !== 'key');
}
/** With an active goal, force a wake every N silent polls (~90s at 15s) so
 *  a stalled loop can never die quietly. */
const GOAL_RECHECK_POLLS = 6;

export function buildSystemPrompt(
  sessionId: string,
  cwd: string,
  variant?: AutonomyVariant | null,
  customPrompt?: string,
): string {
  const lines = [
    `You are the Fraktole reviewer orchestrator for session ${sessionId}. You lead a workforce of agent harnesses and you are accountable for the quality of what it ships. Project root: ${cwd}.`,
    '',
    'OPERATING PROTOCOL',
    '- You are an orchestrator of  a workforce of agent harnesses you launch via terminal. DELEGATE  work by default: building and researching  go to agents harnesses via send_message — spawn_agent first when the workforce is thin.',
    '- When a goal is armed, break it into sub-goals with set_goal (subGoals: [...]) and work through them in parallel (preferred is you monitor one build agent for each subgoal ), make  sure the subgoals set capture every aspects of the goal you capture from the user prompt to not miss anything the user wants, at the cost of having alot of subgoals. keep the list current as you complete items.',
    '- You are read-only on the project: use read_file, list_dir, search_files to grasp context and verify — do not edit or write files yourself; small fixes go to the fixes agent. You may only send terminal input (type_into_tile, send_keystroke, launch_agent) to a tile that is running a harness launcher; never drive a bare shell — that is doing the work yourself, which you must delegate to an agent.',
    '- Start by calling list_tiles so you know what is running; an idle agent is wasted capacity.',
    '- Spawn up to this shape: 3 agent harness tiles (opencode,agy, claude code, or anything else the user might prefer) — 2 build agents for implementation and running fixes, 1 read only agent for extensive review (you tell it that it is read only), and research: the read only agent should also usually be used to validate changes made on the code base.The read only agent is your close conselor.  dispatch each task to the agent harness whose role fits it.',
    '- Read the tail of a tile before judging it; read_scrollback reads the live recording (zero lag) or the on-disk history. When a tile shows no live output yet, read_scrollback is the authoritative view.',
    '- Keep the ledger current: update_task on every assignment (pending/active/done/failed), read_state when unsure.',
    '- Dispatch with precise, verifiable acceptance criteria; the harnesses might stall at boot up , do not kill them hastily, and do not be hasty witht heir responsiveness. You might kill them when they reached about 2 minutes of responsivenesss',
    'You might spawn a plain terminal here and there to help you testing, reading,launching things, that are simple and might not require the workforce',
    'VERIFYING & JUDGING RESULTS',
    '- Verify important results: read_tile (tail), search_files (stubs, TODOs, wrong symbols), read_test_page (console errors, loading); for tests and builds, have the responsible agent run them and report.',
    '- Judge every important result — and its sub-results (builds, tests, pages) — against the goal before accepting it.For example, if user said great frontend, you need to be very STRICT to iterate into great fronted : Be strict with the workforce.',
    '- Reject incomplete, wrong or sloppy work: re-dispatch with a specific, actionable correction, not a vague "do better".',
    '- Do not micro-check trivia; spend your scrutiny where correctness matters.',
    '- When a goal is armed (the [goal: ...] block), you are the loop master: dispatch, verify, re-dispatch until the goal is genuinely met (every sub-goal done), then reply with "GOAL-MET:" and your verdict.',
    '- For uncertain steps (unknown spawn choices), ask the user first with ask_user.',
    'When useing the ask a question too, do multiple rounds ( one for each question )  instead of one call regrouping all the questions you have. Questions to the user are welcome especially when building a project from scratch.',
    'REPORTING',
    '- End every engagement with a verdict: what each agent did, what you verified, what you recommend.',
    '- Keep replies tight. ASCII only : never emojis or decorative unicode in any message, body or reply.',
    '',
  ];
  if (variant && variant in AUTONOMY_PLUGINS) {
    // the custom variant's section is the user's saved directive; the
    // built-in placeholder is the fallback when nothing is saved
    const plugin =
      variant === 'custom' && customPrompt && customPrompt.trim().length > 0
        ? customPrompt
        : AUTONOMY_PLUGINS[variant as AutonomyVariant]!;
    lines.push('', plugin);
  }
  return lines.join('\n');
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
  /** A typed user prompt arrived while a turn was in flight: the current
   *  turn yields at the next tool boundary so the prompt is handled next. */
  private pendingInterrupt = false;
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
  /** Model-tuning knobs (context window, output cap, samplers) captured at
   *  start(); unset = provider defaults, nothing extra on the wire. */
  private knobs: SamplerKnobs | undefined = undefined;
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
  /** Marginal tokens of the current turn, accumulated across every
   *  complete() call of that turn (consumed by recordTurnCost at the turn
   *  boundary). */
  private pendingUsageDelta: number | null = null;
  /** A /compact issued mid-turn: applied at the next turn boundary instead
   *  of splicing the conversation while the model is streaming. */
  private pendingCompact = false;
  /** The local server's REAL context window (probed at start; undefined when
   *  the server does not report one). Drives the compaction budget so the
   *  harness never overruns the server's launch-time `-c`. */
  private serverContext: number | undefined = undefined;
  /** 'loading' when the probe saw the server up but still loading its model
   *  (llama.cpp cold start) — first requests then take minutes, not errors. */
  private serverLoading = false;
  /** Consecutive watchdog-recheck turns that produced no ledger change. */
  private staleWakes = 0;
  /** Fingerprint of the ledger when the last watchdog wake was enqueued. */
  private wakeFingerprint = '';
  /** True once the stall-warning turn has been enqueued for this stall run. */
  private warnedStale = false;
  /** Auto-heal budget per queued turn (finish_reason=length continuations). */
  private healLeft = HEAL_PROMPTS_MAX;
  /** A summarize pass requested while a turn was running or the harness was
   *  down: applied at the next quiet boundary. */
  private pendingSummarize = false;
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
  /** Timer that auto-rejects an unanswered ask_user after askTimeoutMs. */
  private askTimer: NodeJS.Timeout | null = null;
  private askSeq = 0;
  /** The active autonomous-mode variant (null = normal mode). */
  private variant: AutonomyVariant | null = null;
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
      spawnAgent: (kind, cwd, opts) => this.spawnAgent(kind, cwd, opts?.userPicked === true),
      setGoal: (text, subGoals) => this.setGoal(text.length > 0 ? text : null, subGoals),
      openTestPage: (url) => this.opts.toolContext.openTestPage?.(url) ?? Promise.resolve('error: test tab unavailable'),
      readTestPage: () => this.opts.toolContext.readTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
      screenshotTestPage: () => this.opts.toolContext.screenshotTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
      listMessages: () => this.opts.toolContext.listMessages?.() ?? Promise.resolve([]),
      writeToAgent: (agentId, command, opts) =>
        this.opts.toolContext.writeToAgent?.(agentId, command, opts) ?? Promise.resolve('error: launch unavailable'),
      reloadTestPage: () => this.opts.toolContext.reloadTestPage?.() ?? Promise.resolve('error: test tab unavailable'),
    };
  }

  get conversation(): ReviewerEntry[] {
    // queued user prompts are shown the moment they are typed (they emit at
    // queue time) — a transcript reload must see them too, so they are part
    // of the conversation view until processed
    const queued = this.queue.filter((m) => m.announced === true);
    return [...this.messages, ...queued].map(toEntry);
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
    // `||` (not `??`): an empty pasted key must fall back to the env var too
    const key = (cfg.apiKey?.trim() || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] ?? '' : '')).trim();
    const res = resolveReviewerConfig({ ...cfg, apiKey: key });
    // A brand-new config (no key, no pick, no endpoint) must not silently
    // point at the localhost ollama port — first run asks the user to pick.
    if (res.empty) {
      this.setStatus('unconfigured', 'no provider configured — pick a provider (or paste an API key) in the reviewer config');
      return false;
    }
    // A key is required only when the resolved adapter is not keyless local
    // (Ollama / local servers) AND the picked provider demands one. Local
    // servers (auth 'none' or 'optional' — llama.cpp, LM Studio, vLLM…)
    // start with an empty key; the detection path has no entry so it stays
    // adapter-driven (ollama is keyless, everything else needs a key).
    const keyless = res.adapter === 'ollama' || (res.entry !== undefined && res.entry.auth !== 'key');
    if (!keyless && key.length === 0) {
      this.setStatus('unconfigured', 'no API key — paste one in the reviewer config');
      return false;
    }
    this.resolved = res;
    this.apiKey = key;
    this.agentCommand = cfg.agentCommand?.trim() ?? '';
    this.reasoningEffort = cfg.reasoningEffort;
    this.knobs = cfg.knobs;
    this.provider = (this.opts.createProvider ?? createProvider)(res.adapter);
    // probe the local server for its real context window (and readiness) —
    // best-effort: a dead server simply keeps the conservative defaults
    if (isLocalResolution(res) && res.adapter !== 'anthropic') {
      const probe = await (this.opts.probe ?? probeLocalServer)({
        adapter: res.adapter,
        baseUrl: res.baseUrl,
        model: res.model,
      });
      this.serverContext = probe.contextTokens;
      this.serverLoading = probe.state === 'loading';
    } else {
      this.serverContext = undefined;
      this.serverLoading = false;
    }
    this.state = await loadState(this.stateFile);
    this.variant = this.state.variant;
    await this.load();
    // The system prompt lives in the transcript now: it is persisted as the
    // first line and restored verbatim on load, so a session replays exactly
    // the doctrine (base + autonomy plugin block) it ran under. Only
    // conversations that predate system persistence (no system line) get a
    // fresh build here; variant/custom-prompt changes update the line in
    // place via setVariant.
    if (this.messages[0]?.role !== 'system') {
      this.messages.unshift({
        role: 'system',
        content: buildSystemPrompt(this.opts.sessionId, this.opts.cwd, this.variant, this.customPromptOf(cfg)),
      });
      this.persistedCount += 1; // every persisted line shifts by one
      // materialize the system line so the transcript is self-contained —
      // next restarts restore it verbatim instead of rebuilding
      if (await this.rewriteConversation()) {
        this.persistedCount = this.messages.length;
      }
    }
    this.pollsSinceWake = 0;
    this.staleWakes = 0;
    this.warnedStale = false;
    this.startWatch();
    const revivedFromError = this.status === 'error';
    this.setStatus('running');
    // a restored session may already exceed the (now-probed) budget — compact
    // before the first request instead of taking one gratuitous 400
    await this.compactIfNeeded(false, true);
    // surface the previous run's failure once — a dead local loop must not
    // stay mysterious after a restart
    if (this.state.lastError) this.opts.emit.prevError?.(this.state.lastError);
    // tell the UI what budget actually applies (probed server ≤ knob ≤ guess)
    this.opts.emit.budget?.({
      contextTokens: this.contextBudget(),
      probed: this.serverContext,
    });
    // A reloaded session with an armed goal resumes immediately instead of
    // waiting for the watchdog's ~90s polling window (GOAL_RECHECK_POLLS ×
    // 15s). First-ever starts and restarts() have no goal, so no wake fires.
    // When reviving FROM an error, the watchdog drives the wake itself
    // ([watchdog] re-check progress) — adding a second wake would double the
    // turn and, in tests, exhaust a fixed mock response list.
    if (this.state.goal !== null && this.state.goal.state === 'active' && !revivedFromError) {
      this.queue.push({ role: 'user', content: this.withStateBlock('[resume] continuing the autonomous run — re-verify the fork and carry on') });
    }
    // a persisted recap is durable (state.json) — resurface it on every load
    // so the renderer shows it even after a restart
    if (this.state.recap) this.opts.emit.recap?.(this.state.recap);
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
    // stale token accounting would warp the fresh run's compaction/estimate
    // marginals — reset with the conversation
    this.turnTokens = [];
    this.pendingUsageDelta = null;
    this.lastUsageTotal = 0;
    this.staleWakes = 0;
    this.warnedStale = false;
    this.healLeft = HEAL_PROMPTS_MAX;
    await this.truncateConversation();
    await persistState(this.stateFile, this.state, this.opts.logger);
    this.opts.emit.goal({ goal: null, subGoals: [] });
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
   *  explicitly stopped or has no API key. The prompt appears in the
   *  transcript immediately (announced), even while a turn is running —
   *  the queue processes it the moment the current turn ends. */
  async prompt(text: string): Promise<boolean> {
    if (!(await this.ensureStarted())) return false;
    const msg: ProviderMsg = { role: 'user', content: this.withStateBlock(text), announced: true };
    this.queue.push(msg);
    // a typed prompt yields the running turn at the next tool boundary so it
    // is picked up within one model call + tool batch, not after the whole
    // (up to 25-iteration) turn
    if (this.running) this.pendingInterrupt = true;
    this.opts.emit.message(toEntry(msg));
    this.drainQueue();
    return true;
  }

  /** Queues an agent result message as a turn. The body is sanitized at
   *  ingestion so the model never sees (or echoes) emoji. Revives the
   *  harness when it is down (like prompt()) so a result is never dropped —
   *  a transient provider error must not lose a completed task's verdict. */
  async onAgentMessage(msg: FraktoleMessage): Promise<void> {
    if (!(await this.ensureStarted())) return;
    this.queue.push({
      role: 'user',
      content: this.withStateBlock(`[${msg.from} → ${msg.to} (${msg.kind})]: ${sanitizeChatText(msg.body)}`),
    });
    // a completed task verdict yields the running turn at the next tool
    // boundary so the result is picked up within one model call + tool batch,
    // not after the whole (up to 25-iteration) turn. Notes stay FIFO.
    if (this.running && msg.kind === 'result') this.pendingInterrupt = true;
    this.drainQueue();
  }

  /** Arms (text) or disarms (null) the watchdog goal — or subdivides the
   *  CURRENT goal into sub-goals (subGoals, from the model's set_goal). A
   *  new goal text replaces the subdivision; clearing the goal clears it
   *  too. Revives the harness when down, like prompt(). */
  async setGoal(text: string | null, subGoals?: Array<{ text: string; done: boolean }>): Promise<void> {
    if (!(await this.ensureStarted())) return;
    const prev = this.state.goal;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const hasSubs = subGoals !== undefined && subGoals.length > 0;
    let goal: ReviewerGoal | null = null;
    if (trimmed.length > 0) {
      goal = { text: trimmed, setAt: Date.now(), state: 'active' as const };
    } else if (hasSubs) {
      goal = prev; // subdivide the current goal
    }
    if (hasSubs && !goal) return; // no goal to subdivide
    this.state.goal = goal;
    if (hasSubs) {
      const base = Date.now();
      this.state.subGoals = subGoals!
        .map((s, i) => ({
          id: `sg-${base.toString(36)}-${i}`,
          text: s.text.trim().slice(0, 200),
          state: (s.done ? 'done' : 'pending') as 'pending' | 'done',
        }))
        .filter((s) => s.text.length > 0);
    } else if (goal === null || (prev !== null && prev.text !== goal.text)) {
      this.state.subGoals = []; // goal cleared or replaced — the subdivision is stale
    }
    this.pollsSinceWake = 0;
    this.lastLines = new Map([...this.opts.recorder.list()].map(([id, s]) => [id, s.lines]));
    await persistState(this.stateFile, this.state, this.opts.logger);
    this.opts.emit.goal({ goal, subGoals: this.state.subGoals });
    if (goal && (!prev || prev.state !== 'active')) {
      this.queue.push({ role: 'user', content: this.withStateBlock(`[goal armed] ${goal.text}`) });
      this.drainQueue();
    }
  }

  /** Swaps the active autonomous-mode variant (or clears it) and rebuilds
   *  the system prompt in place — the conversation keeps flowing under the
   *  new protocol. */
  async setVariant(variant: AutonomyVariant | null): Promise<void> {
    this.variant = variant;
    this.state.variant = variant;
    await persistState(this.stateFile, this.state, this.opts.logger);
    const systemIdx = this.messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const cfg = await this.opts.getConfig();
      this.messages[systemIdx] = {
        role: 'system',
        content: buildSystemPrompt(this.opts.sessionId, this.opts.cwd, variant, this.customPromptOf(cfg)),
      };
      // the system line is persisted — a swap must land on disk too, or the
      // next reload would restore the pre-switch doctrine
      if (await this.rewriteConversation()) {
        this.persistedCount = this.messages.length;
      }
    }
    this.setStatus(this.status);
  }

  /** The user's saved custom directive (trimmed), or undefined when none
   *  is saved — buildSystemPrompt then falls back to the placeholder. */
  private customPromptOf(cfg: ReviewerConfig): string | undefined {
    const prompt = cfg.customAutonomy?.prompt;
    return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
  }

  /** Starts an autonomous run for a variant: forks the project, arms the
   *  mission goal and kicks the loop off with an announced turn. The custom
   *  variant arms a goal derived from its saved name.
   *
   *  mode 'auto' (default): when the variant already has an active goal AND
   *  a non-empty fork on disk, it RESUMES in place — no re-fork, no re-armed
   *  goal, and a "resuming" kick instead of "begin the loop". mode 'fresh'
   *  always re-forks and starts over. */
  async startAutonomy(variant: AutonomyVariant, mode: 'auto' | 'fresh' = 'auto'): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.ensureStarted())) return { ok: false, error: 'reviewer not running' };
    const dest = join(this.opts.cwd, '.fraktole-auto', variant);
    const resumable = mode !== 'fresh' && this.state.goal?.state === 'active' && (await forkExists(dest));
    const fork = resumable
      ? { ok: true as const, path: dest }
      : // reaching here means a fresh start (or mode 'fresh') — wipe and rebuild
        await (this.opts.forkProject?.(variant, false) ?? Promise.resolve({ ok: false as const, error: 'fork unavailable' }));
    if (!fork.ok) return { ok: false, error: fork.error };
    const cfg = await this.opts.getConfig();
    const mission =
      variant === 'custom'
        ? `Autonomous custom run: ${cfg.customAutonomy?.name?.trim() || 'custom'}`
        : AUTONOMY_MISSIONS[variant];
    await this.setVariant(variant);
    if (!resumable) await this.setGoal(mission);
    const kick: ProviderMsg = {
      role: 'user',
      announced: true,
      content: resumable
        ? `[autonomous mode] variant=${variant} — resuming the previous run in the existing fork at ${fork.path}. Verify the fork state first, then continue: finish the remaining sub-goals and tasks.`
        : `[autonomous mode] variant=${variant} — fork at ${fork.path}. ${mission} Begin the loop: spawn the read-only plan agent inside the fork and start researching.`,
    };
    this.queue.push(kick);
    this.opts.emit.message(toEntry(kick));
    this.drainQueue();
    return { ok: true };
  }

  /** True when re-entering `variant` can resume a prior run in place: an
   *  active goal and a non-empty fork. The UI uses this to offer the resume
   *  dialog before calling startAutonomy. */
  async resumableRun(variant: AutonomyVariant): Promise<{ resumable: boolean; goalText: string | null }> {
    const active = this.state.goal !== null && this.state.goal.state === 'active';
    const exists = await forkExists(join(this.opts.cwd, '.fraktole-auto', variant));
    return { resumable: active && exists, goalText: active && this.state.goal ? this.state.goal.text : null };
  }

  /** Watchdog tick: cheap activity check (line counts only — no model call
   *  unless something wakes the loop). Silent without an active goal. When
   *  a goal is armed and the harness has fallen over (error/offline), it
   *  revives itself and wakes — the loop heals without a user prompt. */
  pollNow(): void {
    const goal = this.state.goal;
    const armed = goal !== null && goal.state === 'active';
    if (this.status !== 'running') {
      if (armed && this.status !== 'stopped') {
        // revive the harness, then wake immediately — a dead loop needs a
        // kick, not another line-count delta check; the stall guard applies
        void this.ensureStarted().then((ok) => {
          if (!ok) return;
          this.pollsSinceWake = 0;
          if (this.staleWakes >= STALE_WAKE_LIMIT) {
            if (!this.warnedStale) {
              this.warnedStale = true;
              this.queue.push({
                role: 'user',
                content: this.withStateBlock(
                  `[stall warning] ${STALE_WAKE_LIMIT} consecutive re-checks produced no goal or task-ledger change. Inspect the tiles (read_scrollback) and either advance one concrete step or declare the blockers explicitly.`,
                ),
              });
              this.drainQueue();
            }
            return;
          }
          this.wakeFingerprint = this.ledgerFingerprint();
          this.queue.push({ role: 'user', content: this.withStateBlock('[watchdog] re-check progress') });
          this.drainQueue();
        });
      }
      return;
    }
    const lines = new Map<string, number>();
    for (const [tileId, summary] of this.opts.recorder.list()) lines.set(tileId, summary.lines);
    const quiet = !armed || this.running || this.queue.length > 0;
    if (quiet) {
      this.lastLines = lines;
      return;
    }
    const delta = [...lines].some(([id, n]) => (this.lastLines.get(id) ?? 0) !== n);
    this.pollsSinceWake += 1;
    if (delta || this.pollsSinceWake >= GOAL_RECHECK_POLLS) {
      this.pollsSinceWake = 0;
      // a stalled loop must not fill the context forever with re-checks
      // that change nothing — after STALE_WAKE_LIMIT straight no-op wakes
      // the re-check loop stands down (one warning turn is enqueued)
      if (this.staleWakes >= STALE_WAKE_LIMIT) {
        if (!this.warnedStale && !this.running && this.queue.length === 0) {
          this.warnedStale = true;
          const note: ProviderMsg = {
            role: 'user',
            content: this.withStateBlock(
              `[stall warning] ${STALE_WAKE_LIMIT} consecutive re-checks produced no goal or task-ledger change. Inspect the tiles (read_scrollback) and either advance one concrete step or declare the blockers explicitly.`,
            ),
          };
          this.queue.push(note);
          this.opts.emit.message(toEntry(note));
          this.drainQueue();
        }
        this.lastLines = lines;
        return;
      }
      this.wakeFingerprint = this.ledgerFingerprint();
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
   *  exclusive, so only one question can ever be pending. In autonomous
   *  mode the question never reaches the user: launcher picks default to
   *  the remembered launcher and everything else auto-resolves, so the run
   *  stays hands-off. */
  private askUser(question: string, kind: ReviewerQuestion['kind'], agentId?: string): Promise<string> {
    if (this.variant !== null) {
      if (kind === 'agent-kind') {
        return Promise.resolve(this.state.lastAgentKind || this.agentCommand || 'opencode');
      }
      return Promise.resolve('proceed');
    }
    // 10 minutes — an unanswered question stalls the loop for a bounded time
    // (the old 10_000_000ms default kept 'running' for ~2.8 hours)
    const timeoutMs = this.opts.askTimeoutMs ?? 600_000;
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
      this.askTimer = setTimeout(() => {
        if (this.pendingAsk === ask) {
          this.pendingAsk = null;
          ask.reject(new Error(`question timed out — no answer within ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
    });
  }

  /** Resolves the pending question with the user's answer (from the UI). */
  answerQuestion(askId: string, answer: string): void {
    const pending = this.pendingAsk;
    if (!pending || pending.askId !== askId) return;
    this.pendingAsk = null;
    if (this.askTimer !== null) {
      clearTimeout(this.askTimer);
      this.askTimer = null;
    }
    pending.resolve(answer);
  }

  private rejectPendingAsk(): void {
    const pending = this.pendingAsk;
    if (!pending) return;
    this.pendingAsk = null;
    if (this.askTimer !== null) {
      clearTimeout(this.askTimer);
      this.askTimer = null;
    }
    pending.reject(new Error('question cancelled'));
  }

  /** User-commanded kill (/kill <id>) and the model's kill_agent share one
   *  direct path — kills never require user confirmation. Never touches
   *  the orchestrator. */
  async killAgentNow(agentId: string): Promise<string> {
    return this.killById(agentId);
  }

  /** Model kill path: always allowed directly. */
  private async tryKillAgent(agentId: string): Promise<string> {
    return this.killById(agentId);
  }

  private async killById(agentId: string): Promise<string> {
    if (agentId === ORCHESTRATOR_ID) return 'error: the orchestrator is not an agent tile';
    const tileId = this.opts.toolContext.tileOfAgent(agentId);
    if (!tileId) return `error: unknown agent ${agentId}`;
    return (await this.opts.toolContext.killAgent?.(tileId)) ?? 'error: kill unavailable';
  }

  /** Routes a reviewer spawn to main (which allocates the agent id and asks
   *  the renderer to mount the tile). On success the chosen kind becomes
   *  the durable default so the next spawn can skip the question. The
   *  userPicked flag (user-authorized launcher) flows to the host gate. */
  private async spawnAgent(kind: string, cwd: string, userPickedFromTool: boolean): Promise<string> {
    const userPicked = userPickedFromTool || (kind.length > 0 && kind === this.state.lastAgentKind);
    const result =
      (await this.opts.toolContext.spawnAgent?.(kind, cwd, { userPicked })) ?? 'error: spawn unavailable';
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
    let block = `[goal: ${goal.text} (${goal.state})] [tasks: ${pending} pending, ${done} done]`;
    if (this.state.subGoals.length > 0) {
      const sd = this.state.subGoals.filter((s) => s.state === 'done').length;
      block += ` [sub-goals: ${sd}/${this.state.subGoals.length} done]`;
    }
    return `${block} ${content}`;
  }

  private startWatch(): void {
    this.stopWatch();
    this.watchTimer = setInterval(() => this.pollNow(), this.opts.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT);
    this.watchTimer.unref();
  }

  /** The effective context budget (tokens): the user's knob wins, but the
   *  probed server window CAPS it (a knob of 32K against a server launched
   *  with -c 8192 must never run the conversation past the real limit).
   *  Local servers without a probe/knob get a conservative 8K — never the
   *  cloud guess of 128K. */
  private contextBudget(): number {
    const override = this.knobs?.contextTokens ?? this.opts.contextBudgetTokens;
    if (this.resolved && isLocalResolution(this.resolved as ConfigResolution)) {
      const base = this.serverContext ?? LOCAL_DEFAULT_BUDGET;
      return override !== undefined ? Math.min(override, base) : base;
    }
    return override !== undefined ? override : contextBudgetTokens(this.resolved?.model ?? '');
  }

  /** The knobs as they go on the wire, with maxOutputTokens clipped so
   *  prompt + output + reserve can never overrun the real context window
   *  (llama.cpp clips silently at n_ctx — the harness must clip first). */
  private knobsForRequest(): SamplerKnobs {
    const maxOut = this.knobs?.maxOutputTokens ?? 4096;
    const remaining = this.contextBudget() - this.estimateTokens() - MAX_TOKENS_RESERVE;
    return { ...this.knobs, maxOutputTokens: Math.max(256, Math.min(maxOut, remaining)) };
  }

  /** A cheap fingerprint of the goal/task ledger: two watchdog wakes produce
   *  the same fingerprint when neither touched the ledger — the stall guard
   *  then stands the re-check loop down. */
  private ledgerFingerprint(): string {
    return JSON.stringify({
      g: this.state.goal?.state ?? null,
      s: this.state.subGoals.map((x) => x.state).join(''),
      t: this.state.tasks.map((x) => `${x.id}:${x.status}`).join('|'),
    });
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** One transparent retry on transient failures (a network blip must not
   *  kill the harness). Deterministic client errors (400/401/403) are never
   *  retried, and the backoff is abort-aware. Aborts are never retried.
   *
   *  Special cases (local servers):
   *   - 503 "Loading model": the server is up but still loading — retry on a
   *     long 15s cycle (LOADING_MAX_ATTEMPTS) instead of erroring while the
   *     user's 25GB model cold-starts.
   *   - context-overflow errors (400 "exceed_context_size_error" / n_ctx):
   *     retryable, with the onContextError hook compacting BEFORE the retry
   *     — the failed request's context is the reason it failed.
   *
   *  Each attempt also carries a stall watchdog: if the provider stream
   *  produces no output (deltas or thinking) for stallTimeoutMs, the
   *  attempt is aborted and treated like a transient failure; a stall that
   *  survives every attempt surfaces as a clear error the watchdog can
   *  heal. */
  private async callWithRetry(
    signal: AbortSignal,
    call: (signal: AbortSignal, onActivity: () => void) => Promise<ProviderResult>,
    onContextError?: (err: unknown) => Promise<void>,
  ): Promise<ProviderResult> {
    const max = this.opts.maxRetries ?? MAX_COMPLETE_RETRIES;
    const stallMs = this.opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      const attemptAborter = new AbortController();
      const composite = AbortSignal.any([signal, attemptAborter.signal]);
      let lastActivity = Date.now();
      const onActivity = (): void => {
        lastActivity = Date.now();
      };
      const stallTimer = setInterval(() => {
        if (Date.now() - lastActivity > stallMs) attemptAborter.abort();
      }, Math.min(5_000, Math.max(50, stallMs / 4)));
      try {
        const result = await call(composite, onActivity);
        clearInterval(stallTimer);
        return result;
      } catch (err) {
        clearInterval(stallTimer);
        if (signal.aborted) throw err;
        if (attemptAborter.signal.aborted) {
          // stalled stream — retryable like any transient failure
          if (attempt >= max) throw new Error(`stream stalled — no output for ${Math.round(stallMs / 1000)}s`);
          await abortableDelay(this.opts.retryDelayMs ?? COMPLETE_RETRY_DELAY_MS, signal);
          continue;
        }
        // a still-loading local server: wait it out on a long cycle — the
        // harness stays 'running' and never error-flaps during boot
        if (isLoadingError(err)) {
          if (attempt >= LOADING_MAX_ATTEMPTS) throw err;
          await abortableDelay(this.opts.loadingRetryMs ?? LOADING_RETRY_MS, signal);
          continue;
        }
        // context overflow: compact the conversation, then retry — the
        // request that just failed is exactly what overflowed it
        if (isContextError(err)) {
          await onContextError?.(err);
          if (attempt >= max) {
            throw new Error(`context limit reached and compaction did not help: ${(err as Error).message.slice(0, 160)}`);
          }
          await abortableDelay(this.opts.retryDelayMs ?? COMPLETE_RETRY_DELAY_MS, signal);
          continue;
        }
        if (attempt >= max || !isRetryableError(err)) throw err;
        await abortableDelay(this.opts.retryDelayMs ?? COMPLETE_RETRY_DELAY_MS, signal);
      }
    }
  }

  /** Manual compaction pass (the /compact command): forces a turn-boundary
   *  compaction now, or defers it to the next turn boundary if the model is
   *  mid-run. */
  compact(): void {
    this.compactIfNeeded(true);
  }

  /** Manual "summarize session": asks the model for a concise recap, persists
   *  it to state.recap (survives restarts), emits it, then compacts the
   *  conversation down to the recap. Deferred to the next quiet boundary when
   *  a turn is running or the harness is down (mirrors /compact). Returns
   *  { ok: false } when the reviewer is explicitly stopped. */
  summarizeSession(): { ok: boolean; error?: string } {
    if (this.status === 'stopped') return { ok: false, error: 'reviewer is stopped' };
    if (this.status !== 'running' || this.running) {
      this.pendingSummarize = true;
      return { ok: true };
    }
    this.pendingSummarize = false;
    this.queue.push({
      role: 'user',
      content: this.withStateBlock(
        '[summarize] Produce a concise session summary: the goal, each sub-goal and its status, the task ledger, work completed so far, and what remains open. Under 300 words, plain text.',
      ),
    });
    this.drainQueue();
    return { ok: true };
  }

  /** Aborts the in-flight provider call; queued turns are dropped. */
  cancel(): void {
    this.aborter?.abort();
    this.aborter = null;
  }

  private setStatus(status: ReviewerStatus, error?: string): void {
    this.status = status;
    this.opts.emit.status(status, error, this.resolved?.model, this.variant);
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
      while (this.queue.length > 0 && !aborter.signal.aborted) {
        const turnStart = this.messages.length;
        this.pendingUsageDelta = null; // per-turn usage marginal, see below
        const turn = this.queue.shift()!;
        this.lastTurnWasWake = typeof turn.content === 'string' && turn.content.includes('context was compacted');
        // ANY watchdog turn (re-check or compaction wake) is a loop turn: its
        // ledger effect is measured against wakeFingerprint for the
        // stall guard
        const isWatchdogTurn = typeof turn.content === 'string' && turn.content.includes('[watchdog]');
        // bounded auto-heal: every fresh queued turn gets its own budget
        this.healLeft = HEAL_PROMPTS_MAX;
        this.messages.push(turn);
        await this.persist();
        // prompts are announced at queue time — skip the duplicate emit
        if (!turn.announced) this.opts.emit.message(toEntry(turn));
        // Clear the interrupt flag now that this turn's setup is done. A
        // prompt that arrived during setup (persist/emit above) must not
        // nuke a turn that has not started; only a prompt that lands while a
        // model call / tool is running (below) preempts at the next boundary.
        this.pendingInterrupt = false;

        let exhausted = false;
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          if (aborter.signal.aborted) break;
          // a queued user prompt yields the turn at the tool boundary: the
          // current iteration (complete + tool results) is already persisted,
          // so breaking here never orphans the conversation
          if (this.pendingInterrupt) break;
          const response = await this.callWithRetry(
            aborter.signal,
            (signal, onActivity) =>
              this.provider.complete({
                model: res.model,
                apiKey: this.apiKey,
                baseUrl: res.baseUrl,
                messages: this.messages,
                tools: this.tools.definitions(),
                signal,
                reasoningEffort: this.reasoningEffort ?? defaultReasoningEffort(res),
                // maxOutputTokens is clipped to the REAL remaining window —
                // a local server clips silently (finish_reason=length);
                // the harness clips first so the reply is never cut mid-JSON
                knobs: this.knobsForRequest(),
                onDelta: (delta, thinking) => {
                  onActivity();
                  this.opts.emit.stream({
                    delta,
                    thinking: thinking && thinking.length > 0 ? thinking : undefined,
                  });
                },
              }),
            // when the server bounces a prompt that overflows its context,
            // the hook compacts HARD so the retry fits — and never re-sends
            // the same overflowing request
            () => this.compactIfNeeded(true, true),
          );
          const clipped = response.finishReason === 'length';
          // never persist an empty toolCalls array: providers reject
          // "tool_calls": [] on the next request (OpenAI 400s on it)
          const assistant: ProviderMsg = {
            role: 'assistant',
            content: response.text,
            thinking: response.thinking.length > 0 ? response.thinking : undefined,
          };
          if (response.toolCalls.length > 0) assistant.toolCalls = response.toolCalls;
          // the provider clipped the generation mid-tool-call: a truncated
          // JSON argument would never parse — mark it so the execution step
          // below reports it instead of running the tool with garbage args
          const truncatedCalls = new Set(
            response.toolCalls.filter((c) => clipped && hasRawArgs(c.args)).map((c) => c.id),
          );
          // provider-faithful content blocks (anthropic thinking blocks with
          // signatures) — replayed verbatim on the next call for thinking
          // continuity in tool loops
          if (response.contentBlocks && response.contentBlocks.length > 0) assistant.contentBlocks = response.contentBlocks;
          this.messages.push(assistant);
          if (response.usage) {
            const total = response.usage.inputTokens + response.usage.cachedTokens + response.usage.outputTokens;
            // accumulate across every complete() call of the turn — an
            // overwrite would only keep the last iteration's marginal
            this.pendingUsageDelta = (this.pendingUsageDelta ?? 0) + Math.max(1, total - this.lastUsageTotal);
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

          // a goal is only met when the model stops working — a reply that
          // still carries tool calls is mid-work, not a verdict
          if (response.toolCalls.length === 0 && isGoalMet(response.text) && this.state.goal?.state === 'active') {
            this.state.goal.state = 'met';
            if (this.state.subGoals.length > 0) {
              this.state.subGoals = this.state.subGoals.map((s) => ({ ...s, state: 'done' }));
            }
            await persistState(this.stateFile, this.state, this.opts.logger);
            this.opts.emit.goal({ goal: this.state.goal, subGoals: this.state.subGoals });
          }

          if (response.toolCalls.length === 0) {
            // a reply cut off by the output limit is a TRUNCATED reply, not a
            // verdict: continue exactly where it ended, at most
            // HEAL_PROMPTS_MAX times per turn (bounded auto-heal)
            if (clipped && this.healLeft > 0) {
              this.healLeft -= 1;
              const heal: ProviderMsg = {
                role: 'user',
                content:
                  '[continue] Your previous reply was cut off at the provider\'s output limit. Continue exactly where you left off — if you were issuing a tool call, issue the COMPLETE one now.',
              };
              this.messages.push(heal);
              await this.persist();
              this.opts.emit.message(toEntry(heal));
              continue;
            }
            break;
          }
          for (const call of response.toolCalls) {
            // a cancel (restart/stop/idle) must end the turn promptly —
            // the in-flight tool's rejection is a normal error result
            if (aborter.signal.aborted) break;
            const started = Date.now();
            this.opts.emit.toolCall({ callId: call.id, name: call.name, args: call.args, state: 'start', at: Date.now() });
            let result: string;
            if (truncatedCalls.has(call.id)) {
              // never run a tool with args cut off mid-JSON — close the
              // tool window with an explicit error instead so the retry
              // request stays API-valid
              result =
                'error: the tool call above was truncated by the provider (finish_reason=length, arguments do not parse). Re-issue this call with complete, valid arguments.';
              this.opts.emit.toolCall({
                callId: call.id,
                name: call.name,
                args: call.args,
                state: 'error',
                error: result,
                durationMs: 0,
                at: Date.now(),
              });
            } else {
              result = await this.tools.run(call.name, call.args, this.toolContext);
            }
            const durationMs = Date.now() - started;
            if (result.startsWith('error:')) {
              if (!truncatedCalls.has(call.id)) {
                this.opts.emit.toolCall({ callId: call.id, name: call.name, args: call.args, state: 'error', error: result, durationMs, at: Date.now() });
              }
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
            const capped = result.length > TOOL_RESULT_CHARS ? `${result.slice(0, TOOL_RESULT_CHARS)}\n...[truncated]` : result;
            this.messages.push({ role: 'tool', content: capped, toolCallId: call.id });
            this.opts.emit.message(toEntry(this.messages[this.messages.length - 1]!));
          }
          // A failed tool must NOT end the turn: the error result is in the
          // model's context, and it decides whether to retry, adapt or
          // reply. MAX_TOOL_ITERATIONS still bounds runaway retries.
          if (aborter.signal.aborted) {
            // a mid-batch cancel must never leave an unanswered tool_calls
            // block behind (every provider rejects it): roll back the
            // assistant reply and any partial tool results, keeping the
            // (already persisted) user prompt so the question survives
            this.messages.length = turnStart + 1;
            this.persistedCount = turnStart + 1;
            break;
          }
          await this.persist();
          if (i === MAX_TOOL_ITERATIONS - 1) exhausted = true;
        }
        this.recordTurnCost(turnStart);
        // the iteration cap is a visible event, not a quiet death: the loop
        // tells the model it hit the cap and hands over its next concrete
        // step as a fresh turn
        if (exhausted) {
          const note: ProviderMsg = {
            role: 'user',
            content: `[loop note] the tool loop reached its ${MAX_TOOL_ITERATIONS}-iteration cap. Use this turn to close status: verify the ledger (update_task every assignment), then state ONE next concrete step.`,
          };
          this.queue.unshift(note);
          this.opts.emit.message(toEntry(note));
          this.drainQueue();
        }
        // watchdog re-checks that change nothing are counted: three no-ops
        // in a row stand the re-check loop down (context stops filling)
        // (the fingerprint is captured when the wake was enqueued)
        if (isWatchdogTurn) {
          if (this.ledgerFingerprint() === this.wakeFingerprint) this.staleWakes += 1;
          else {
            this.staleWakes = 0;
            this.warnedStale = false;
          }
        }
        // the run is alive: clear the previous failure and stamp the last
        // turn — persisted only on the transition (an error → healthy flip);
        // a per-turn write would slow every turn boundary for no reader
        this.state.lastTurnAt = Date.now();
        if (this.state.lastError) {
          this.state.lastError = null;
          await persistState(this.stateFile, this.state, this.opts.logger);
        }
        // a completed summarize turn: capture the model's recap, persist it,
        // then compact the older exchanges away — the recap is now the
        // durable record of everything before it
        if (typeof turn.content === 'string' && turn.content.includes('[summarize]')) {
          let reply = '';
          for (let k = this.messages.length - 1; k >= turnStart; k--) {
            if (this.messages[k]!.role === 'assistant') {
              reply = this.messages[k]!.content;
              break;
            }
          }
          if (reply && reply.length > 0) {
            this.state.recap = { text: reply, at: Date.now() };
            await persistState(this.stateFile, this.state, this.opts.logger);
            this.opts.emit.recap?.(this.state.recap);
            // big compact: after the model produced the recap, wipe the
            // ENTIRE conversation and make the recap the new context start.
            // The system prompt (base doctrine + autonomy plugin block) is
            // preserved at messages[0] — only the history is dropped.
            await this.bigCompact(reply);
          }
        }
        await this.compactIfNeeded(false, true);
      }
    } catch (err) {
      if (!aborter.signal.aborted) {
        // a bare 'fetch failed' (TypeError) tells nobody which server is
        // dead — rephrase with the endpoint so a dead local server is
        // self-explanatory
        const message =
          err instanceof TypeError
            ? `cannot reach ${this.resolved?.baseUrl ?? 'the configured endpoint'} — check the local server is running (${(err as Error).message})`
            : (err as Error).message;
        this.setStatus('error', message);
        // the failure is durable: a restart resurfhaces it (prevError)
        this.state.lastError = message;
        void persistState(this.stateFile, this.state, this.opts.logger);
      }
    } finally {
      this.running = false;
      this.aborter = null;
      // a /compact deferred mid-turn lands here when the run ends early
      // (abort/error) without reaching the turn-boundary call
      if (this.pendingCompact) void this.compactIfNeeded(false, true);
      // a summarize pass deferred the same way is applied at the next quiet
      // moment (or revives the harness when it is merely idle)
      if (this.pendingSummarize && !this.running) {
        this.pendingSummarize = false;
        void this.ensureStarted().then((ok) => {
          if (!ok) return;
          this.summarizeSession();
        });
      }
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
  private async compactIfNeeded(force = false, atBoundary = false): Promise<void> {
    if (this.running && !atBoundary) {
      if (force) this.pendingCompact = true;
      return;
    }
    const doForce = force || this.pendingCompact;
    this.pendingCompact = false;
    // the user's context knob drives the budget (80% of the window); the
    // per-model guesses stay as the fallback for knob-less configs
    const budget = Math.floor(contextBudgetTokens(this.resolved?.model ?? '', this.knobs?.contextTokens ?? this.opts.contextBudgetTokens) * 0.8);
    let dropped = 0;
    let userIdx: number[] = [];
    for (;;) {
      userIdx = [];
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
      // role user + position right after the oldest kept user turn: the
      // note joins that turn's content and never looks like a second
      // system — or, on a reloaded conversation (no system prompt at
      // index 0), never lands between an assistant and its tool results
      const note: ProviderMsg = {
        role: 'user',
        content: `[context compacted: ${dropped} exchanges dropped — your goal and ledger are unchanged; continue]`,
      };
      this.messages.splice(userIdx[0]! + 1, 0, note);
      this.opts.emit.message(toEntry(note));
      // re-sync the write cursor (the compacted prefix is claimed on disk;
      // the note rides along with the rewrite below)
      this.persistedCount = this.messages.length;
      // make the compaction durable: the append-only file would otherwise
      // resurrect every dropped turn on the next reload
      await this.rewriteConversation();
      if (this.state.goal?.state === 'active' && !this.lastTurnWasWake) {
        this.wakeFingerprint = this.ledgerFingerprint();
        this.queue.push({ role: 'user', content: this.withStateBlock('[watchdog] context was compacted — re-check progress') });
        this.drainQueue();
      }
    }
  }

  /** Big compact (the /summarize path): resets the conversation to just the
   *  system prompt plus one user turn embedding the freshly produced recap.
   *  The system prompt (base doctrine + autonomy plugin block) is preserved
   *  at messages[0]; every historical exchange is dropped and the recap
   *  becomes the new context start. Token accounting is reset and the wipe
   *  is made durable by rewriting the conversation file. */
  private async bigCompact(recap: string): Promise<void> {
    const system = this.messages.find((m) => m.role === 'system');
    const summary: ProviderMsg = {
      role: 'user',
      content: this.withStateBlock(
        `[big compact] A summary of all prior work is below — it is now the entire context. Treat it as the starting point. Continue from here; your goal and task ledger are unchanged.\n\n${recap}`,
      ),
    };
    if (system) {
      this.messages = [system, summary];
    } else {
      // no system prompt (should not happen after start) — still reset to the
      // summary so /summarize always collapses to a single user turn
      this.messages = [summary];
    }
    this.turnTokens = [];
    this.persistedCount = this.messages.length;
    await this.rewriteConversation();
  }

  /** Rewrites the conversation file to exactly the in-memory messages —
   *  the system prompt included (it is part of the transcript; a reloaded
   *  session restores it verbatim). Atomic via tmp + rename; failures are
   *  logged and the old file is left in place (a reload then simply sees
   *  the pre-compaction history). Returns whether the rewrite succeeded —
   *  callers that reset the write cursor on top of it must only do so on
   *  success. */
  private async rewriteConversation(): Promise<boolean> {
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      const lines = this.messages.map((m) => JSON.stringify(m));
      const tmp = `${this.conversationFile}.tmp`;
      await writeFile(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
      await rename(tmp, this.conversationFile);
      return true;
    } catch (err) {
      this.opts.logger?.(`reviewer: conversation rewrite failed (${(err as Error).message})`);
      return false;
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
   *  request. A tool message without a toolCallId is a broken response: it
   *  can never be replayed (providers require the id) and marks the whole
   *  window unrecoverable. */
  private repairSequence(msgs: ProviderMsg[]): ProviderMsg[] {
    const out: ProviderMsg[] = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i]!;
      if (m.role === 'assistant') {
        const calls = (m.toolCalls ?? []).map((c) => c.id).sort();
        const responses: string[] = [];
        let broken = false;
        let j = i + 1;
        while (j < msgs.length && msgs[j]!.role === 'tool') {
          if (msgs[j]!.toolCallId) responses.push(msgs[j]!.toolCallId!);
          else broken = true;
          j += 1;
        }
        responses.sort();
        const exact =
          !broken &&
          ((calls.length === 0 && responses.length === 0) ||
            (calls.length === responses.length && calls.every((id, k) => id === responses[k]!)));
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
   *  prompt is persisted like any other line (it is part of the
   *  transcript). The write cursor advances only after a successful write —
   *  a failed append is retried on the next persist instead of silently
   *  losing the lines. */
  private async persist(): Promise<void> {
    if (this.persistedCount >= this.messages.length) return;
    const fresh = this.messages.slice(this.persistedCount);
    const lines = fresh.map((m) => {
      const { announced: _announced, ...rest } = m;
      return JSON.stringify(rest);
    });
    if (lines.length === 0) {
      // nothing to write; the cursor still advances so the next persist
      // starts at the right line
      this.persistedCount = this.messages.length;
      return;
    }
    try {
      await mkdir(dirname(this.conversationFile), { recursive: true });
      await appendFile(this.conversationFile, `${lines.join('\n')}\n`, 'utf8');
      this.persistedCount = this.messages.length;
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
      // nothing to clear (a missing file is already empty)
    }
    // always reset the cursor — a stale count would silently skip the
    // first writes of the fresh conversation
    this.persistedCount = 0;
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

/** Whether a provider failure is worth retrying: network failures (fetch
 *  rejects with TypeError) and server-side/rate-limit statuses. A 4xx
 *  client error is deterministic — retrying it wastes 2s+ and a request.
 *  Context-overflow errors are the exception: they are deterministic, yet
 *  they REPAIR themselves by compacting (callWithRetry does that via
 *  onContextError), so they are retryable. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    if (isContextError(err)) return true;
    const m = err.message.match(/API error ([45]\d\d)/);
    if (m) return Number(m[1]!) >= 429;
  }
  return true; // unknown failures: one retry is the safe default
}

/** A context-overflow error from an OpenAI-compatible or native server
 *  (llama.cpp's 400 "exceed_context_size_error" / "larger than the max
 *  context size", "n_ctx", ollama's "context length exceeded", etc.). */
function isContextError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\bexceed.*context\b|\bbeyond\s+context\b|larger than the max context|exceeds the available context|context (size|window|length|limit)|n_ctx|n_prompt_tokens/i.test(
    err.message,
  );
}

/** The server is alive but still loading its model (503 "Loading model" on
 *  llama.cpp/vLLM) — a wait, not a failure. */
function isLoadingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /loading model|still loading|please wait.*load|model is loading/i.test(err.message);
}

/** True when a tool call's args were left as `{ _raw }` — the provider was
 *  clipped mid-JSON and parseArgs could not reconstruct the payload. */
function hasRawArgs(args: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(args, '_raw');
}

/** setTimeout that rejects early when the signal aborts — a stop() during
 *  the backoff must not stall the harness for the full delay. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
