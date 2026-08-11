import { spawn } from 'node:child_process';

export interface TerminalProcess {
  kill(): void;
  exited: Promise<{ code: number | null }>;
}

/** strips ANSI escape sequences so agent output renders as clean text lines */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export interface RunCommandOpts {
  cwd: string;
  command: string;
  onOutput: (text: string) => void;
}

/**
 * Runs a command locally (independent of the daemon) through the user's shell,
 * streaming combined stdout/stderr output live.
 */
export function runCommand({ cwd, command, onOutput }: RunCommandOpts): TerminalProcess {
  const child = spawn('/bin/bash', ['-c', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (chunk: Buffer): void => {
    const text = stripAnsi(chunk.toString());
    if (text.length > 0) onOutput(text);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.on('exit', (code) => resolve({ code }));
    child.on('error', () => resolve({ code: null }));
  });
  return {
    kill: () => child.kill('SIGTERM'),
    exited,
  };
}
