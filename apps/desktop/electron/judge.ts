import { join } from 'node:path';
import type { PtyHost } from './pty-host.js';
import { ORCHESTRATOR_ID } from './mailbox.js';

/** The env contract every PTY gets: agents and the judge locate their
 *  mailboxes purely from environment variables. */
export function buildAgentEnv(
  sessionId: string,
  agentId: string,
  role: 'agent' | 'judge',
  sessionDir: string,
): Record<string, string> {
  const box = join(sessionDir, 'agents', agentId);
  return {
    FRAKTOLE_SESSION_ID: sessionId,
    FRAKTOLE_SESSION_DIR: sessionDir,
    FRAKTOLE_AGENT_ID: agentId,
    FRAKTOLE_ROLE: role,
    FRAKTOLE_INBOX: join(box, 'inbox'),
    FRAKTOLE_OUTBOX: join(box, 'outbox'),
  };
}

export type JudgeStatus = 'offline' | 'running' | 'exited';

export interface JudgeHostOpts {
  host: PtyHost;
  getCommand: () => string;
}

/**
 * The orchestrator's judge: a CLI agent (opencode by default) running in a
 * PTY owned by the panel, outside the workspace tree. Spawned when a session
 * opens, killed when it closes. The PTY tile id is fixed — 'orchestrator' —
 * which is also the mailbox id other agents address.
 */
export class JudgeHost {
  status: JudgeStatus = 'offline';

  constructor(private readonly opts: JudgeHostOpts) {}

  /** Judge cwd: the session's last focused agent's cwd, else home.
   *  Returns false when the CLI cannot be started. */
  spawn(sessionId: string, sessionDir: string, cwd: string): boolean {
    const command = this.opts.getCommand();
    const env = buildAgentEnv(sessionId, ORCHESTRATOR_ID, 'judge', sessionDir);
    try {
      this.opts.host.spawn(ORCHESTRATOR_ID, {
        cwd,
        cols: 80,
        rows: 24,
        command,
        args: [],
        envExt: env,
      });
      this.status = 'running';
      return true;
    } catch (err) {
      console.error(`judge spawn failed (${command}):`, err);
      this.status = 'exited';
      return false;
    }
  }

  kill(): void {
    this.opts.host.kill(ORCHESTRATOR_ID);
    this.status = 'offline';
  }

  markExited(): void {
    this.status = 'exited';
  }

  get cwd(): string | null {
    return this.opts.host.cwdOf(ORCHESTRATOR_ID);
  }
}
