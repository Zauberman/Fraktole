import { join } from 'node:path';
import type { FraktoleMessage, ReviewerEntry, SessionFile, SessionState } from '../src/shared/ipc.js';
import type { ReviewerStatus } from './reviewer.js';

/** Minimal shapes the runtime depends on, so tests can inject fakes. */
export interface RuntimeHost {
  spawn(tileId: string, opts: { cwd: string; cols: number; rows: number; command?: string; args?: string[]; envExt?: Record<string, string> }): { pid: number; cwd: string };
  kill(tileId: string): void;
  killAll(): void;
  write(tileId: string, data: string): void;
  resize(tileId: string, cols: number, rows: number): void;
  cwdOf(tileId: string): string | null;
}

/** The harness reviewer: our own model loop (no PTY, no CLI). Spawned lazily
 *  when its tab is visited; idles out when backgrounded. */
export interface RuntimeReviewer {
  status: ReviewerStatus;
  start(sessionId: string, sessionDir: string, cwd: string): Promise<boolean>;
  stop(): void;
  idleOut(): void;
  restart(): Promise<boolean>;
  compact(): void;
  prompt(text: string): Promise<void>;
  cancel(): void;
  setGoal(text: string | null): Promise<void>;
  answerQuestion(askId: string, answer: string): void;
  killAgentNow(agentId: string): Promise<string>;
  onAgentMessage(msg: FraktoleMessage): void;
  /** Live transcript entries, for the Reviewer tab on mount. */
  conversation: ReviewerEntry[];
}

export interface RuntimeRouter {
  start(sessionId: string): void;
  stop(): void;
  sendFromOrchestrator(msg: {
    id: string;
    from: string;
    to: string;
    kind: 'task' | 'result' | 'note';
    body: string;
    ref?: string;
    at: number;
  }): Promise<boolean>;
  listMessages(sessionId: string): Promise<unknown[]>;
}

export interface SessionRuntimeOpts {
  session: SessionFile;
  sessionRoot: string; // userData/sessions
  host: RuntimeHost;
  reviewer: RuntimeReviewer;
  router: RuntimeRouter;
  judgeCwd: () => string;
  idleTimeoutMs?: number;
  logger?: (line: string) => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * One live session: its PTY host, reviewer harness and mailbox router, plus
 * the lifecycle state machine.
 *
 *   running  — everything alive (may be backgrounded)
 *   idle     — backgrounded long enough that the reviewer shut down (tiles stay)
 *   stopped  — user switched it off: all PTYs and the reviewer are dead
 *
 * Keep-alive: a backgrounded session keeps its tiles running; only the
 * reviewer idles out. Explicit stop tears the whole runtime down; start
 * revives it (the renderer re-spawns tiles from the persisted arrangement).
 */
export class SessionRuntime {
  state: SessionState = 'running';
  agentToTile = new Map<string, string>();
  lastActiveAt = Date.now();

  private sessionRef: SessionFile;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: SessionRuntimeOpts) {
    this.sessionRef = opts.session;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  get id(): string {
    return this.sessionRef.id;
  }

  get session(): SessionFile {
    return this.sessionRef;
  }

  get host(): RuntimeHost {
    return this.opts.host;
  }

  get reviewer(): RuntimeReviewer {
    return this.opts.reviewer;
  }

  get router(): RuntimeRouter {
    return this.opts.router;
  }

  /** Keep the runtime's view of the session file in sync after saves. */
  updateSession(session: SessionFile): void {
    this.sessionRef = session;
  }

  sessionDir(): string {
    return join(this.opts.sessionRoot, this.sessionRef.id);
  }

  /** Called when this session becomes the active one. */
  activate(): void {
    this.lastActiveAt = Date.now();
    this.clearIdleTimer();
    if (this.state === 'stopped') this.state = 'running';
  }

  /** Called when another session becomes active. */
  deactivate(): void {
    this.lastActiveAt = Date.now();
    this.startIdleTimer();
  }

  /** The reviewer starts only when its tab is actually visited. Revives a
   *  stopped session first. */
  ensureReviewer(): Promise<boolean> {
    if (this.state === 'stopped') this.start();
    if (this.opts.reviewer.status === 'running') {
      return Promise.resolve(true);
    }
    return this.opts.reviewer.start(this.sessionRef.id, this.sessionDir(), this.opts.judgeCwd());
  }

  /** Explicit off switch: kills every PTY and the reviewer. */
  stop(): void {
    this.clearIdleTimer();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = 'stopped';
  }

  /** Revives a stopped session; the renderer re-spawns the tiles and the
   *  reviewer comes back on the next reviewer visit. */
  start(): void {
    if (this.state !== 'stopped') return;
    this.state = 'running';
    this.opts.router.start(this.sessionRef.id);
  }

  /** Full teardown (session deleted). */
  teardown(): void {
    this.clearIdleTimer();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = 'stopped';
  }

  killAll(): void {
    this.opts.host.killAll();
  }

  private startIdleTimer(): void {
    if (this.idleTimer !== null || this.state === 'stopped') return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // still backgrounded: shut the reviewer down, keep the tiles alive
      if (this.state !== 'stopped') {
        this.opts.reviewer.idleOut();
        this.state = 'idle';
        this.opts.logger?.(`session ${this.id}: reviewer idle-shutdown`);
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export interface SessionRegistryOpts {
  sessionRoot: string;
  makeRuntime: (session: SessionFile) => SessionRuntime;
  logger?: (line: string) => void;
}

/**
 * All live sessions. Runtimes are created lazily on first open and stay
 * until the session is deleted or the app quits.
 */
export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private activeId: string | null = null;

  constructor(private readonly opts: SessionRegistryOpts) {}

  get active(): string | null {
    return this.activeId;
  }

  get(id: string): SessionRuntime | null {
    return this.runtimes.get(id) ?? null;
  }

  all(): SessionRuntime[] {
    return [...this.runtimes.values()];
  }

  /** Activates a session, creating its runtime on first visit. */
  open(id: string, session: SessionFile): SessionRuntime {
    if (this.activeId !== null && this.activeId !== id) {
      this.runtimes.get(this.activeId)?.deactivate();
    }
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = this.opts.makeRuntime(session);
      this.runtimes.set(id, rt);
    }
    rt.updateSession(session);
    rt.activate();
    this.activeId = id;
    return rt;
  }

  stop(id: string): void {
    this.runtimes.get(id)?.stop();
  }

  start(id: string): void {
    this.runtimes.get(id)?.start();
  }

  /** Deletes the runtime (and kills everything in it). */
  teardown(id: string): void {
    this.runtimes.get(id)?.teardown();
    this.runtimes.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  /** App quit: everything dies. */
  killAll(): void {
    for (const rt of this.runtimes.values()) rt.killAll();
  }
}

