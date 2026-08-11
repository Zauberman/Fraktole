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

/**
 * One PTY per tile. Children are spawned as session leaders by node-pty, so
 * killing the negative pid kills the shell and its whole process group —
 * agents started inside a tile die with it.
 */
export class PtyHost {
  private readonly sessions = new Map<string, { pty: pty.IPty; cwd: string }>();

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
    term.onData((data) => this.opts.send(IPC.ptyData, tileId, data));
    term.onExit(({ exitCode }) => {
      const payload: PtyExitPayload = { code: exitCode };
      this.opts.send(IPC.tileExit, tileId, payload);
      this.sessions.delete(tileId);
    });
    this.sessions.set(tileId, { pty: term, cwd: opts.cwd });
    return { pid: term.pid, cwd: opts.cwd };
  }

  write(tileId: string, data: string): void {
    this.sessions.get(tileId)?.pty.write(data);
  }

  cwdOf(tileId: string): string | null {
    return this.sessions.get(tileId)?.cwd ?? null;
  }

  resize(tileId: string, cols: number, rows: number): void {
    this.sessions.get(tileId)?.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
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
    const escalation = setTimeout(() => {
      if (this.sessions.has(tileId)) {
        try {
          process.kill(-term.pid, 'SIGKILL');
        } catch {
          term.kill('SIGKILL');
        }
      }
    }, 2_000);
    escalation.unref();
  }

  killAll(): void {
    for (const tileId of [...this.sessions.keys()]) this.kill(tileId);
  }
}
