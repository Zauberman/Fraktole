import { spawn } from 'node:child_process';
import type { PluginConfig } from '@fraktole/core';
import { wireProcess, type AgentDriver, type DriverHooks, type DriverProcess, type SpawnSpec } from './index.js';

export function pluginDriver(config: PluginConfig): AgentDriver {
  return {
    id: config.id,
    spawn(spec: SpawnSpec, hooks: DriverHooks): DriverProcess {
      const child = spawn(config.command, [...config.args, spec.goal], {
        cwd: spec.worktreePath,
        env: { ...process.env, ...spec.env, PWD: spec.worktreePath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return wireProcess(child, hooks);
    },
  };
}
