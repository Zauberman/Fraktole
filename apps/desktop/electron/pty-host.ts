import * as pty from 'node-pty';
import type { PtyExitPayload } from '../src/shared/ipc.js';
import { IPC } from '../src/shared/ipc.js';

export interface PtySession {
  pid: number;
  cwd: string;
}

export interface PtySpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  /** Program to run; defaults to $SHELL. The judge spawns a CLI agent here. */
  command?: string;
  args?: string[];
  /** Extra env for the child: the FRAKTOLE_* mailbox contract. */
  envExt?: Record<string, string>;
}

interface PtyHostOpts {
  send: (channel: string, tileId: string, payload: unknown) => void;
}

interface PtySessionEntry {
  pty: pty.IPty;
  cwd: string;
  /** Pending SIGKILL escalation from kill(); cleared when the pty exits. */
  killTimer: NodeJS.Timeout | null;
}

/**
 * One PTY per tile. Children are spawned as session leaders by node-pty, so
 * killing the negative pid kills the shell and its whole process group —
 * agents started inside a tile die with it.
 */
export class PtyHost {
  private readonly sessions = new Map<string, PtySessionEntry>();

  constructor(private readonly opts: PtyHostOpts) {}

  spawn(tileId: string, opts: PtySpawnOpts): PtySession {
    const shell = process.env.SHELL ?? '/bin/bash';
    const term = pty.spawn(opts.command ?? shell, opts.args ?? [], {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PWD: opts.cwd,
        ...opts.envExt,
      },
    });
    const entry: PtySessionEntry = { pty: term, cwd: opts.cwd, killTimer: null };
    term.onData((data) => this.opts.send(IPC.ptyData, tileId, data));
    term.onExit(({ exitCode }) => {
      // clear any pending kill escalation so it can never fire against a
      // recycled tileId/pid, and only drop the entry if it is still ours
      if (entry.killTimer !== null) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      const payload: PtyExitPayload = { code: exitCode };
      this.opts.send(IPC.tileExit, tileId, payload);
      if (this.sessions.get(tileId) === entry) this.sessions.delete(tileId);
    });
    this.sessions.set(tileId, entry);
    return { pid: term.pid, cwd: opts.cwd };
  }

  write(tileId: string, data: string): void {
    const session = this.sessions.get(tileId);
    if (!session) return;
    try {
      session.pty.write(data);
    } catch {
      // the pty exited between our lookup and the write — nothing to do
    }
  }

  cwdOf(tileId: string): string | null {
    return this.sessions.get(tileId)?.cwd ?? null;
  }

  resize(tileId: string, cols: number, rows: number): void {
    const session = this.sessions.get(tileId);
    if (!session) return;
    try {
      session.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      // the pty exited between our lookup and the resize — nothing to do
    }
  }

  kill(tileId: string): void {
    const session = this.sessions.get(tileId);
    if (!session) return;
    const { pty: term } = session;
    try {
      process.kill(-term.pid, 'SIGTERM');
    } catch {
      term.kill('SIGTERM');
    }
    session.killTimer = setTimeout(() => {
      session.killTimer = null;
      // only escalate while this exact session still owns the tileId
      if (this.sessions.get(tileId) === session) {
        try {
          process.kill(-term.pid, 'SIGKILL');
        } catch {
          term.kill('SIGKILL');
        }
      }
    }, 2_000);
    session.killTimer.unref();
  }

  killAll(): void {
    for (const tileId of [...this.sessions.keys()]) this.kill(tileId);
  }
}
