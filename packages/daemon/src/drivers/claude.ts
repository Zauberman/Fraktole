import { spawn } from 'node:child_process';
import { wireProcess, type AgentDriver, type DriverHooks, type DriverProcess, type SpawnSpec } from './index.js';

// NOTE: flags verified against `claude --help` at build time only when the CLI
// is installed; the documented headless invocation is `claude -p` + output format.
export const claudeDriver: AgentDriver = {
  id: 'claude',
  spawn(spec: SpawnSpec, hooks: DriverHooks): DriverProcess {
    const child = spawn(
      'claude',
      ['-p', spec.goal, '--output-format', 'text'],
      {
        cwd: spec.worktreePath,
        // PWD must match the real cwd (see opencode driver); a stale inherited PWD leaks.
        env: { ...process.env, ...spec.env, PWD: spec.worktreePath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return wireProcess(child, hooks);
  },
};
