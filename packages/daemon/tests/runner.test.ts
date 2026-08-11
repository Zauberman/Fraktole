import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Task } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import type { AgentDriver, DriverProcess } from '../src/drivers/index.js';
import { DriverRegistry, UnknownDriverError, wireProcess } from '../src/drivers/index.js';
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

describe('DriverRegistry', () => {
  it('registers and resolves drivers by id', () => {
    const registry = new DriverRegistry();
    registry.register({ id: 'stub' } as AgentDriver);
    expect(registry.get('stub').id).toBe('stub');
    expect(() => registry.get('nope')).toThrow(UnknownDriverError);
  });
});

describe('AgentRunner', () => {
  function makeRunner(driver: AgentDriver, defaultTimeoutMs: number) {
    const bus = new EventBus();
    const events: Array<{ kind: string; payload: unknown }> = [];
    bus.subscribe((ev) => events.push({ kind: ev.kind, payload: ev.payload }));
    const registry = new DriverRegistry();
    registry.register(driver);
    const runner = new AgentRunner({ bus, registry, defaultTimeoutMs });
    return { bus, events, runner };
  }

  it('streams stdout chunks as LogChunk events and records exit code', async () => {
    const driver: AgentDriver = {
      id: 'stub',
      spawn(_spec, hooks) {
        hooks.onStdout('hello ');
        hooks.onStdout('world\n');
        hooks.onStderr('warn\n');
        const exited = new Promise<void>((resolve) => {
          setTimeout(() => {
            hooks.onExit(0, null);
            resolve();
          }, 10);
        });
        return { pid: 42, kill: () => {}, exited };
      },
    };
    const { events, runner } = makeRunner(driver, 1000);
    const task = makeTask();
    await runner.run(task);

    const chunks = events.filter((e) => e.kind === 'LogChunk');
    expect(chunks.map((c) => (c.payload as { stream: string }).stream)).toEqual([
      'stdout',
      'stdout',
      'stderr',
    ]);
    expect(chunks.map((c) => (c.payload as { text: string }).text).join('')).toBe(
      'hello world\nwarn\n',
    );
    expect((events.find((e) => e.kind === 'AgentExited')?.payload as { exitCode: number }).exitCode).toBe(0);
    expect((events.find((e) => e.kind === 'AgentSpawned')?.payload as { pid: number }).pid).toBe(42);
    expect(task.exitCode).toBe(0);
    expect(task.pid).toBe(42);
  });

  it('fails the task when the agent exits non-zero', async () => {
    const driver: AgentDriver = {
      id: 'stub',
      spawn(_spec, hooks) {
        const exited = new Promise<void>((resolve) => {
          setTimeout(() => {
            hooks.onExit(3, null);
            resolve();
          }, 5);
        });
        return { pid: 1, kill: () => {}, exited };
      },
    };
    const { runner } = makeRunner(driver, 1000);
    await expect(runner.run(makeTask())).rejects.toThrow('agent exited with code 3');
  });

  it('kills and fails on timeout', async () => {
    let killCalled = false;
    const driver: AgentDriver = {
      id: 'stub',
      spawn(_spec, hooks) {
        let resolveExit: () => void = () => {};
        const exited = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });
        return {
          pid: 1,
          kill: () => {
            killCalled = true;
            hooks.onExit(null, 'SIGTERM');
            resolveExit();
          },
          exited,
        };
      },
    };
    const { runner } = makeRunner(driver, 50);
    await expect(runner.run(makeTask())).rejects.toThrow('timed out after 50ms');
    expect(killCalled).toBe(true);
  });

  it('rejects unknown drivers', async () => {
    const { runner } = makeRunner({ id: 'stub' } as AgentDriver, 1000);
    await expect(runner.run(makeTask({ driver: 'ghost' }))).rejects.toThrow('unknown agent driver');
  });

  it('fails fast (no hang) when the driver process cannot start', async () => {
    type FakeChild = EventEmitter & {
      pid: number;
      stdout: Readable;
      stderr: Readable;
      kill: () => boolean;
    };
    const driver: AgentDriver = {
      id: 'stub',
      spawn(_spec, hooks) {
        const child = new EventEmitter() as FakeChild;
        child.pid = 0;
        child.stdout = new Readable({ read() {} });
        child.stderr = new Readable({ read() {} });
        child.kill = () => false;
        // a failed spawn fires 'error' and never 'exit'
        setTimeout(() => child.emit('error', new Error('ENOENT: no such file')), 0);
        return wireProcess(child, hooks);
      },
    };
    const { runner, events } = makeRunner(driver, 1000);
    await expect(runner.run(makeTask())).rejects.toThrow('agent exited with code unknown');
    const exited = events.find((e) => e.kind === 'AgentExited');
    expect((exited?.payload as { exitCode: number | null }).exitCode).toBeNull();
  });
});
