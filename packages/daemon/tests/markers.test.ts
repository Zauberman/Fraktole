import { describe, expect, it } from 'vitest';
import type { Task } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import type { AgentDriver, DriverProcess } from '../src/drivers/index.js';
import { DriverRegistry } from '../src/drivers/index.js';
import { AgentRunner } from '../src/runner.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    goal: 'goal',
    repoPath: '/repo',
    baseBranch: 'main',
    branch: 'fraktole/t1',
    driver: 'stub',
    status: 'queued',
    statusSince: new Date().toISOString(),
    gates: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    worktreePath: '/wt',
    ...overrides,
  };
}

function outputDriver(chunks: string[]): AgentDriver {
  return {
    id: 'stub',
    spawn(_spec, hooks) {
      let i = 0;
      const exited = new Promise<void>((resolve) => {
        const emit = (): void => {
          if (i >= chunks.length) {
            hooks.onExit(0, null);
            resolve();
            return;
          }
          hooks.onStdout(chunks[i++]!);
          setTimeout(emit, 1);
        };
        setTimeout(emit, 1);
      });
      return { pid: 1, kill: () => {}, exited } as DriverProcess;
    },
  };
}

describe('AgentRunner gate markers', () => {
  it('strips FRAKTOLE-GATE lines and reports the reason', async () => {
    const bus = new EventBus();
    const gates: Array<{ taskId: string; reason: string }> = [];
    const registry = new DriverRegistry();
    registry.register(
      outputDriver(['line one\n', 'FRAKTOLE-GATE: needs approval before deploy\n', 'line two\n']),
    );
    const runner = new AgentRunner({
      bus,
      registry,
      defaultTimeoutMs: 5000,
      onAgentGate: (taskId, reason) => gates.push({ taskId, reason }),
    });

    const chunks: string[] = [];
    bus.subscribe((ev) => {
      if (ev.kind === 'LogChunk') chunks.push(ev.payload.text);
    });

    await runner.run(makeTask());

    expect(gates).toEqual([{ taskId: 't1', reason: 'needs approval before deploy' }]);
    expect(chunks.join('')).toBe('line one\nline two\n');
  });
});
