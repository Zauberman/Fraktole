import * as pty from 'node-pty';
import type { PtyExitPayload } from '../src/shared/ipc.js';
import { IPC } from '../src/shared/ipc.js';

export interface PtySession {
  pid: number;
  cwd: string;
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

  spawn(tileId: string, cwd: string, cols: number, rows: number): PtySession {
    const shell = process.env.SHELL ?? '/bin/bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', PWD: cwd },
    });
    term.onData((data) => this.opts.send(IPC.ptyData, tileId, data));
    term.onExit(({ exitCode }) => {
      const payload: PtyExitPayload = { code: exitCode };
      this.opts.send(IPC.tileExit, tileId, payload);
      this.sessions.delete(tileId);
    });
    this.sessions.set(tileId, { pty: term, cwd });
    return { pid: term.pid, cwd };
  }

  write(tileId: string, data: string): void {
    this.sessions.get(tileId)?.pty.write(data);
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
