import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OpenedSession, SessionFile, SessionSummary } from '../src/shared/ipc.js';

/**
 * Named Fraktole sessions: the durable home of every agent, its mailbox and
 * the workspace arrangement. Layout under userData/sessions/:
 *
 *   index.json                 [{id, name, updatedAt}] — session order
 *   <sid>/session.json         the SessionFile model (tree as agent ids)
 *   <sid>/agents/<id>/{inbox,outbox}/   message mailboxes
 *   <sid>/snapshots/           judge snapshots of terminal sessions
 *   <sid>/scrollback/          terminal buffer captures for restore
 *
 * Every write goes through a tmp-file + rename so a crash can never leave a
 * half-written file behind (same discipline as SettingsStore).
 */
/** Session ids are always internally generated as s-<ts36>-<rand36>
 *  (see newSessionId); anything else must never reach the filesystem. */
export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Monotonic counter for unique tmp names: two concurrent saves of the same
 *  session share one tmp path with a fixed name and interleave on rename. */
let persistSeq = 0;

/** Index updater for installs that happen outside a store instance (bundle
 *  imports): inserts/moves the entry to the front of index.json. Never
 *  rewrites from a corrupt read — a broken index file is left for the
 *  store's quarantine path to rebuild. */
export async function touchSessionIndex(root: string, entry: { id: string; name: string; updatedAt: number }): Promise<void> {
  const indexFile = join(root, 'index.json');
  let entries: Array<{ id: string; name: string; updatedAt: number }> = [];
  try {
    const parsed = JSON.parse(await readFile(indexFile, 'utf8')) as { sessions?: Array<{ id: string; name: string; updatedAt: number }> };
    if (Array.isArray(parsed.sessions)) entries = parsed.sessions;
  } catch (err) {
    // a missing index is fine (fresh install) — create it below; a CORRUPT
    // one is left alone for SessionStore.readIndex() to quarantine+rebuild
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const rest = entries.filter((e) => e.id !== entry.id);
  const tmp = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ sessions: [{ id: entry.id, name: entry.name, updatedAt: entry.updatedAt }, ...rest] }, null, 2), 'utf8');
  await rename(tmp, indexFile);
}

export class SessionStore {
  constructor(private readonly root: string) {}

  /** Session ids are always internally generated as s-<ts36>-<rand36>
   *  (see newSession); anything else must never reach the filesystem. */
  private static readonly ID_RE = /^s-[a-z0-9-]+$/;

  private dir(id: string): string {
    if (!SessionStore.ID_RE.test(id)) throw new Error(`invalid session id ${id}`);
    return join(this.root, id);
  }

  private indexFile(): string {
    return join(this.root, 'index.json');
  }

  private sessionFile(id: string): string {
    return join(this.dir(id), 'session.json');
  }

  private async readIndex(): Promise<Array<{ id: string; name: string; updatedAt: number }>> {
    let raw: string;
    try {
      raw = await readFile(this.indexFile(), 'utf8');
    } catch {
      return []; // genuinely missing — a fresh install
    }
    try {
      const parsed = JSON.parse(raw) as { sessions?: Array<{ id: string; name: string; updatedAt: number }> };
      if (!Array.isArray(parsed.sessions)) throw new Error('bad index shape');
      return parsed.sessions;
    } catch {
      // A corrupt index must NEVER be rewritten from an empty read — that
      // would orphan every session dir on disk. Quarantine the bad file and
      // rebuild from the session dirs that actually exist.
      await rename(this.indexFile(), `${this.indexFile()}.bad-${Date.now()}`).catch(() => undefined);
      return this.rebuildIndex();
    }
  }

  /** Rebuilds index.json from the session dirs on disk (valid session.json
   *  required per dir) and persists it, newest first. */
  private async rebuildIndex(): Promise<Array<{ id: string; name: string; updatedAt: number }>> {
    let ids: string[] = [];
    try {
      ids = (await readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const entries: Array<{ id: string; name: string; updatedAt: number }> = [];
    for (const id of ids) {
      if (!SessionStore.ID_RE.test(id)) continue;
      try {
        const session = await this.load(id);
        entries.push({ id, name: session.name, updatedAt: session.updatedAt });
      } catch {
        // unreadable session dir — leave it out of the index but keep the dir
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.writeIndex(entries).catch(() => undefined);
    return entries;
  }

  private async writeIndex(entries: Array<{ id: string; name: string; updatedAt: number }>): Promise<void> {
    await this.persist(this.indexFile(), { sessions: entries });
  }

  /** Per-file write queues: serializes concurrent persist() calls targeting
   *  the same file (renderer auto-save racing a spawn-time save). */
  private readonly writeQueues = new Map<string, Promise<void>>();

  private async persist(file: string, data: unknown): Promise<void> {
    const run = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${(persistSeq += 1)}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, file);
    };
    const prev = this.writeQueues.get(file) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.writeQueues.set(
      file,
      next.catch(() => undefined),
    );
    void next.then(
      () => {
        if (this.writeQueues.get(file) === next) this.writeQueues.delete(file);
      },
      () => {
        if (this.writeQueues.get(file) === next) this.writeQueues.delete(file);
      },
    );
    return next;
  }

  async list(): Promise<SessionSummary[]> {
    const entries = await this.readIndex();
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      try {
        const session = await this.load(entry.id);
        summaries.push({
          id: entry.id,
          name: entry.name,
          updatedAt: entry.updatedAt,
          agentCount: session.tiles.length,
          projectPath: session.projectPath,
        });
      } catch {
        // a corrupt/missing session.json must not hide every other session.
        // The index entry STAYS — auto-deleting it would turn a transient
        // read failure into permanent session loss; the dir is simply not
        // listed while unreadable.
      }
    }
    return summaries;
  }

  async newSession(name: string): Promise<OpenedSession> {
    const id = newSessionId();
    const now = Date.now();
    const session: SessionFile = {
      version: 1,
      id,
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : `Session ${new Date().toLocaleDateString()}`,
      createdAt: now,
      updatedAt: now,
      nextAgentSeq: 1,
      judge: null,
      tree: null,
      tiles: [],
    };
    await mkdir(this.dir(id), { recursive: true });
    await this.ensureSessionDirs(id);
    await this.persist(this.sessionFile(id), session);
    await this.touchIndex(id, session.name, now);
    return { session, agents: [], state: 'running' };
  }

  async rename(id: string, name: string): Promise<SessionFile> {
    const session = await this.load(id);
    session.name = typeof name === 'string' && name.trim().length > 0 ? name.trim() : session.name;
    session.updatedAt = Date.now();
    await this.persist(this.sessionFile(id), session);
    await this.touchIndex(id, session.name, session.updatedAt);
    return session;
  }

  async load(id: string): Promise<SessionFile> {
    const raw = await readFile(this.sessionFile(id), 'utf8');
    const session = JSON.parse(raw) as SessionFile;
    if (
      session.version !== 1 ||
      typeof session.id !== 'string' ||
      typeof session.name !== 'string' ||
      !Array.isArray(session.tiles) ||
      typeof session.nextAgentSeq !== 'number'
    ) {
      throw new Error(`unsupported session format in ${id}`);
    }
    return session;
  }

  /** Persists the session model (arrangement, zoom/focus, agent list). */
  async save(session: SessionFile): Promise<void> {
    session.updatedAt = Date.now();
    await this.ensureSessionDirs(session.id);
    await this.persist(this.sessionFile(session.id), session);
    await this.touchIndex(session.id, session.name, session.updatedAt);
  }

  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
    const entries = await this.readIndex();
    await this.writeIndex(entries.filter((e) => e.id !== id));
  }

  /** Monotonic agent ids per session; never reused across save/load cycles. */
  allocateAgentId(session: SessionFile): string {
    const id = `agent-${session.nextAgentSeq}`;
    session.nextAgentSeq += 1;
    return id;
  }

  async ensureSessionDirs(id: string): Promise<void> {
    const dir = this.dir(id);
    await mkdir(join(dir, 'agents'), { recursive: true });
    await mkdir(join(dir, 'snapshots'), { recursive: true });
    await mkdir(join(dir, 'scrollback'), { recursive: true });
  }

  async ensureAgentMailbox(id: string, agentId: string): Promise<void> {
    await mkdir(join(this.dir(id), 'agents', agentId, 'inbox'), { recursive: true });
    await mkdir(join(this.dir(id), 'agents', agentId, 'outbox'), { recursive: true });
  }

  /** Known agent ids in this session (from disk, so it also sees boxes left
   *  behind by exited agents). */
  async listAgentIds(id: string): Promise<string[]> {
    const dir = join(this.dir(id), 'agents');
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  private async touchIndex(id: string, name: string, updatedAt: number): Promise<void> {
    const entries = await this.readIndex();
    const rest = entries.filter((e) => e.id !== id);
    await this.writeIndex([{ id, name, updatedAt }, ...rest]);
  }
}
