import { watch, type FSWatcher } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FraktoleMessage, SessionFile } from '../src/shared/ipc.js';
import { readMessagesJsonl } from './messages-log.js';

export const ORCHESTRATOR_ID = 'orchestrator';

/** Message ids must be unique per session; a per-process counter keeps
 *  m-<ts>-<seq> distinct even when two messages land in the same ms. */
let seq = 0;
export function messageId(): string {
  seq += 1;
  return `m-${Date.now()}-${seq}`;
}

/** Ids and targets flow into filesystem paths (mailbox dirs, inbox file
 *  names): keep them flat so a crafted message can never escape the
 *  session's agents directory. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Star topology + kind whitelist. The orchestrator may message any agent;
 *  an agent may only message the orchestrator. */
export function routeMessage(msg: FraktoleMessage, srcRole: 'agent' | 'judge'): 'ok' | 'forbidden' | 'malformed' {
  if (!msg || typeof msg !== 'object') return 'malformed';
  if (typeof msg.from !== 'string' || typeof msg.to !== 'string') return 'malformed';
  if (typeof msg.id !== 'string') return 'malformed';
  if (typeof msg.body !== 'string' || typeof msg.at !== 'number') return 'malformed';
  if (msg.kind !== 'task' && msg.kind !== 'result' && msg.kind !== 'note') return 'malformed';
  if (srcRole === 'agent' && msg.to !== ORCHESTRATOR_ID) return 'forbidden';
  if (msg.to === msg.from) return 'forbidden';
  if (!SAFE_ID_RE.test(msg.id) || !SAFE_ID_RE.test(msg.from) || !SAFE_ID_RE.test(msg.to)) return 'malformed';
  return 'ok';
}

/** Control bytes that could inject terminal escape sequences into the echo
 *  line (CSI/OSC and friends) — the echo goes to a live terminal. */
// eslint-disable-next-line no-control-regex
const ESC_SCRUB_RE = /[\x00-\x1f\x7f]/g;

/** Visible text injected into the target's terminal so a human or TUI agent
 *  sees the message; the panel log and mailbox files are the canonical copy. */
export function echoText(from: string, to: string, kind: string, body: string): string {
  const safe = body.replace(ESC_SCRUB_RE, '');
  return `\r\n\x1b[36m[fraktole]\x1b[0m ${from} \x1b[2m\u2192\x1b[0m ${to} \x1b[2m(${kind})\x1b[0m: ${safe}\r\n`;
}

export interface MailboxRouterOpts {
  /** Root that holds session dirs (userData/sessions). */
  root: string;
  currentSession: () => SessionFile | null;
  /** Live tileId for an agent id; 'orchestrator' maps to the judge tile. */
  tileOfAgent: (agentId: string) => string | null;
  write: (tileId: string, text: string) => void;
  emit: (msg: FraktoleMessage) => void;
  logger?: (line: string) => void;
}

function log(opts: MailboxRouterOpts, line: string): void {
  (opts.logger ?? console.log)(line);
}

/** Compaction thresholds (usage-log's pattern): messages.jsonl used to grow
 *  unboundedly while every ingest and dedup check parsed the whole file. */
const LOG_COMPACT_EVERY = 1_000;
const LOG_MAX_LINES = 5_000;
const LOG_KEEP_LINES = 4_000;

/**
 * File mailboxes: agents write m-*.json files into their outbox, Fraktole
 * routes them to the target's inbox and echoes them into the target's
 * terminal. The canonical, append-only message log is messages.jsonl inside
 * the session dir. Detection = recursive fs.watch (fast path) plus a 2s
 * outbox scan (safety net — inotify can drop events on busy trees).
 */
export class MailboxRouter {
  private watcher: FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private pendingScanTimer: NodeJS.Timeout | null = null;
  private scanPending = false;
  /** One in-flight scan; the watcher path and the interval share it so two
   *  passes can never ingest the same outbox file concurrently. */
  private scanPromise: Promise<void> | null = null;
  /** Serializes log appends: hydrate/append/compact on messages.jsonl must
   *  not interleave (lost updates, torn lines). */
  private appendQueue: Promise<void> = Promise.resolve();
  /** Message ids already in the canonical log, per session — the dedup
   *  index. Hydrated once from disk, then maintained in memory: dedup is
   *  O(1) instead of a full-file parse per message. */
  private readonly loggedIds = new Map<string, Set<string>>();
  private appendedSinceCompact = 0;

  constructor(private readonly opts: MailboxRouterOpts) {}

  start(sessionId: string): void {
    this.stop();
    const agentsDir = join(this.opts.root, sessionId, 'agents');
    try {
      this.watcher = watch(agentsDir, { recursive: true }, () => this.scheduleScan());
      // async watcher failures (EPERM/EMFILE, network fs, dir deleted) emit
      // 'error' — unhandled, they would crash the main process
      this.watcher.on('error', (err) => {
        log(this.opts, `mailbox watcher error (${String(err)}); relying on the scan`);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      log(this.opts, `mailbox watcher unavailable (${String(err)}); relying on the scan`);
    }
    this.scanTimer = setInterval(() => this.scanOutboxes(), 2_000);
    this.scanTimer.unref();
    this.scheduleScan();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    if (this.pendingScanTimer) clearTimeout(this.pendingScanTimer);
    this.pendingScanTimer = null;
    this.scanPending = false;
  }

  private scheduleScan(): void {
    if (this.scanPending) return;
    this.scanPending = true;
    this.pendingScanTimer = setTimeout(() => {
      this.pendingScanTimer = null;
      this.scanPending = false;
      void this.scanOutboxes();
    }, 150);
  }

  /** Reads every outbox and ingests new message files. Concurrent callers
   *  (interval + watcher) share one in-flight pass. */
  scanOutboxes(): Promise<void> {
    if (this.scanPromise !== null) return this.scanPromise;
    const run = this.doScan().finally(() => {
      this.scanPromise = null;
    });
    this.scanPromise = run;
    return run;
  }

  private async doScan(): Promise<void> {
    const session = this.opts.currentSession();
    if (!session) return;
    const agentsDir = join(this.opts.root, session.id, 'agents');
    let agents: string[];
    try {
      agents = (await readdir(agentsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const agentId of agents) {
      const outbox = join(agentsDir, agentId, 'outbox');
      let files: string[];
      try {
        files = await readdir(outbox);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^m-\d+-\d+\.json$/.test(file)) continue;
        await this.ingestOutboxFile(join(outbox, file), agentId);
      }
    }
  }

  /** Moves an unreadable/rejected message file into quarantine/ next to its
   *  mailbox instead of unlinking it — a partially-written producer must not
   *  lose mail permanently. */
  private async quarantine(file: string): Promise<void> {
    const dir = join(dirname(file), '..', '..', 'quarantine');
    await mkdir(dir, { recursive: true });
    await rename(file, join(dir, `${basename(file)}.${Date.now()}.bad`)).catch(() => unlink(file).catch(() => undefined));
  }

  /** Reads one outbox file, delivers it, then consumes it. */
  async ingestOutboxFile(file: string, sourceAgentId: string): Promise<void> {
    const session = this.opts.currentSession();
    if (!session) return;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return; // already consumed elsewhere
    }
    let msg: FraktoleMessage;
    try {
      msg = JSON.parse(raw) as FraktoleMessage;
    } catch {
      // the writer may still be mid-write: retry once after a beat before
      // declaring the file malformed and dropping it
      await new Promise((r) => setTimeout(r, 250));
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return; // already consumed elsewhere
      }
      try {
        msg = JSON.parse(raw) as FraktoleMessage;
      } catch {
        log(this.opts, `mailbox: quarantining malformed ${file}`);
        await this.quarantine(file).catch(() => undefined);
        return;
      }
    }
    const verdict = routeMessage(msg, sourceAgentId === ORCHESTRATOR_ID ? 'judge' : 'agent');
    if (verdict !== 'ok') {
      log(this.opts, `mailbox: ${file} rejected (${verdict})`);
      await this.quarantine(file).catch(() => undefined);
      return;
    }
    msg.from = sourceAgentId;
    try {
      // dedup is deliver's job, but when the message is already in the
      // canonical log the file must still be consumed (and never redelivered)
      if (await this.alreadyLogged(session.id, msg.id)) {
        log(this.opts, `mailbox: ${file} already delivered — consuming`);
      } else {
        await this.deliver(msg, sourceAgentId);
      }
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }

  /** Validates + writes a message produced inside Fraktole (the composer). */
  async sendFromOrchestrator(msg: FraktoleMessage): Promise<boolean> {
    const session = this.opts.currentSession();
    if (!session) return false;
    if (routeMessage(msg, 'judge') !== 'ok') return false;
    if (!session.tiles.some((t) => t.agentId === msg.to)) return false;
    await this.deliver(msg, ORCHESTRATOR_ID);
    return true;
  }

  /** Routes a message to the target's inbox, appends the canonical log and
   *  echoes it into the target's terminal. Idempotent by message id. */
  async deliver(msg: FraktoleMessage, sourceAgentId: string): Promise<void> {
    const session = this.opts.currentSession();
    if (!session) return;
    if (await this.alreadyLogged(session.id, msg.id)) return;
    if (sourceAgentId !== ORCHESTRATOR_ID) msg.from = sourceAgentId;
    if (msg.at === 0) msg.at = Date.now();

    const agentsDir = join(this.opts.root, session.id, 'agents');
    // belt over routeMessage's flat-id check: never write outside agentsDir
    const targetDir = resolve(join(agentsDir, msg.to));
    if (!targetDir.startsWith(resolve(agentsDir) + sep)) {
      log(this.opts, `mailbox: refusing target outside the agents dir (${msg.to})`);
      return;
    }
    await mkdir(join(targetDir, 'inbox'), { recursive: true });
    await this.appendLog(session.id, msg);
    await writeFile(join(targetDir, 'inbox', `${msg.id}.json`), JSON.stringify(msg, null, 2), 'utf8');

    const tileId = this.opts.tileOfAgent(msg.to);
    if (tileId) this.opts.write(tileId, echoText(msg.from, msg.to, msg.kind, msg.body));
    this.opts.emit(msg);
  }

  /** Exact id match against the in-memory index — a raw substring check
   *  would false-positive on ids like m-<ts>-1 vs m-<ts>-12. */
  private async alreadyLogged(sessionId: string, id: string): Promise<boolean> {
    const ids = await this.loggedIdSet(sessionId);
    return ids.has(id);
  }

  /** Hydrates the id index once per session. A legacy file without a
   *  trailing newline is normalized first so appends can never concatenate
   *  onto a torn last line. */
  private async loggedIdSet(sessionId: string): Promise<Set<string>> {
    let ids = this.loggedIds.get(sessionId);
    if (ids) return ids;
    ids = new Set();
    const file = this.logFile(sessionId);
    try {
      let raw = await readFile(file, 'utf8');
      if (raw.length > 0) {
        if (!raw.endsWith('\n')) {
          raw = `${raw}\n`;
          const tmp = `${file}.hydrate.${Date.now()}.tmp`;
          await writeFile(tmp, raw, 'utf8');
          await rename(tmp, file);
        }
        for (const line of raw.split('\n')) {
          if (line.length === 0) continue;
          try {
            const id = (JSON.parse(line) as { id?: unknown }).id;
            if (typeof id === 'string') ids.add(id);
          } catch {
            // torn line — the file was written via append, ignore it
          }
        }
      }
    } catch {
      // no log yet — first message in this session
    }
    this.loggedIds.set(sessionId, ids);
    return ids;
  }

  private logFile(sessionId: string): string {
    return join(this.opts.root, sessionId, 'messages.jsonl');
  }

  /** Append-only log: `appendFile` (O(new line), no full-file rewrite).
   *  Appends are queued so concurrent deliveries cannot interleave, and the
   *  id index grows with each append. Compaction keeps the file bounded. */
  private appendLog(sessionId: string, msg: FraktoleMessage): Promise<void> {
    const run = this.appendQueue.then(() => this.doAppendLog(sessionId, msg));
    this.appendQueue = run.catch(() => undefined);
    return run;
  }

  private async doAppendLog(sessionId: string, msg: FraktoleMessage): Promise<void> {
    const file = this.logFile(sessionId);
    const ids = await this.loggedIdSet(sessionId);
    await appendFile(file, `${JSON.stringify(msg)}\n`, 'utf8');
    ids.add(msg.id);
    this.appendedSinceCompact += 1;
    if (this.appendedSinceCompact >= LOG_COMPACT_EVERY) {
      this.appendedSinceCompact = 0;
      await this.compactLog(sessionId, ids);
    }
  }

  /** Rewrites the log keeping the most recent tail so the file (and every
   *  legacy full-file reader like listMessages) stays bounded. Runs inside
   *  the append queue — no concurrent writer can interleave. */
  private async compactLog(sessionId: string, ids: Set<string>): Promise<void> {
    const file = this.logFile(sessionId);
    try {
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      if (lines.length <= LOG_MAX_LINES) return;
      const kept = lines.slice(-LOG_KEEP_LINES);
      const tmp = `${file}.compact.${Date.now()}.tmp`;
      await writeFile(tmp, `${kept.join('\n')}\n`, 'utf8');
      await rename(tmp, file);
      ids.clear();
      for (const line of kept) {
        try {
          const id = (JSON.parse(line) as { id?: unknown }).id;
          if (typeof id === 'string') ids.add(id);
        } catch {
          // ignore
        }
      }
      log(this.opts, `mailbox: compacted messages.jsonl (${lines.length} → ${kept.length} lines)`);
    } catch (err) {
      log(this.opts, `mailbox: log compaction failed: ${String(err)}`);
    }
  }

  async listMessages(sessionId: string): Promise<FraktoleMessage[]> {
    const messages = (await readMessagesJsonl(this.opts.root, sessionId)) as FraktoleMessage[];
    // coerce legacy at:0/undefined timestamps so they sort as oldest,
    // never NaN (which would make the sort a no-op)
    return messages.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }
}
