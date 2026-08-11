import { spawn } from 'node:child_process';
import { wireProcess, type AgentDriver, type DriverHooks, type DriverProcess, type SpawnSpec } from './index.js';

export const opencodeDriver: AgentDriver = {
  id: 'opencode',
  spawn(spec: SpawnSpec, hooks: DriverHooks): DriverProcess {
    const child = spawn('opencode', ['run', spec.goal], {
      cwd: spec.worktreePath,
      // PWD must match the real cwd: opencode trusts env.PWD over getcwd(),
      // and the daemon inherits a stale PWD from its own spawner.
      env: { ...process.env, ...spec.env, PWD: spec.worktreePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return wireProcess(child, hooks);
  },
};
