import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, LimitsConfig } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import type { AgentDriver, DriverProcess } from '../src/drivers/index.js';
import { DriverRegistry } from '../src/drivers/index.js';
import { GateManager } from '../src/gates.js';
import { daemonHandlers } from '../src/index.js';
import { AgentRunner } from '../src/runner.js';
import { PlanRejectedError, TaskEngine } from '../src/task-engine.js';
import { WorktreeManager } from '../src/worktrees.js';

const execFileP = promisify(execFile);
const LIMITS: LimitsConfig = { maxConcurrent: 2, defaultTimeoutMs: 60_000, gateTimeoutMs: 30_000 };

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}

const stubDriver: AgentDriver = {
  id: 'opencode',
  spawn(_spec, hooks) {
    setTimeout(() => {
      hooks.onExit(0, null);
    }, 1);
    return {
      pid: 1,
      kill: () => {},
      exited: new Promise<void>((resolve) => {
        const orig = hooks.onExit;
        hooks.onExit = (code, signal) => {
          orig(code, signal);
          resolve();
        };
      }),
    } as DriverProcess;
  },
};

interface Harness {
  bus: EventBus;
  engine: TaskEngine;
  events: EventEnvelope[];
  repo: string;
}

async function makeHarness(planner: { throws: boolean }): Promise<Harness> {
  const repo = await mkdtemp(join(tmpdir(), 'fraktole-fb-repo-'));
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await writeFile(join(repo, 'README.md'), '# F\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'init'], repo);

  const wts = await mkdtemp(join(tmpdir(), 'fraktole-fb-wts-'));
  const worktrees = new WorktreeManager({ worktreesDir: wts });
  const bus = new EventBus();
  const events: EventEnvelope[] = [];
  bus.subscribe((ev) => events.push(ev));
  const registry = new DriverRegistry();
  registry.register(stubDriver);
  const runner = new AgentRunner({ bus, registry, defaultTimeoutMs: 5000 });
  const gates = new GateManager({
    worktrees,
    bus,
    policy: { mergeToMain: false, destructiveCommands: true, externalNetwork: false, heavyActions: false },
  });
  const handlers = daemonHandlers({
    worktrees,
    runner,
    planner: {
      name: 'stub',
      planTask: async () => {
        if (planner.throws) throw new PlanRejectedError('planner is down');
        return { rationale: 'r', tasks: [] };
      },
    },
    gates,
    bus,
  });
  const engine = new TaskEngine({ bus, handlers, limits: LIMITS });
  gates.attachEngine(engine);
  return { bus, engine, events, repo };
}

describe('planner fallback to direct run', () => {
  it('runs the goal directly when the planner throws (with a warning)', async () => {
    const { engine, events, repo } = await makeHarness({ throws: true });
    const task = engine.createTask({
      goal: 'fix the typo',
      repoPath: repo,
      baseBranch: 'main',
      driver: 'opencode',
      orchestrate: true,
    });
    await engine.drain();

    expect(task.status).toBe('done');
    expect(task.subtaskIds).toBeUndefined(); // no decomposition happened
    const warnings = events.filter((ev) => ev.kind === 'LogChunk');
    expect(warnings.some((w) => w.payload.text.includes('planner unavailable'))).toBe(true);
  });

  it('never calls the planner for direct (non-orchestrate) tasks', async () => {
    const { engine, events, repo } = await makeHarness({ throws: true });
    const task = engine.createTask({
      goal: 'direct only',
      repoPath: repo,
      baseBranch: 'main',
      driver: 'opencode',
    });
    await engine.drain();

    expect(task.status).toBe('done');
    expect(task.subtaskIds).toBeUndefined();
    // exactly one TaskCreated: the direct task itself, no decomposition
    expect(events.filter((ev) => ev.kind === 'TaskCreated')).toHaveLength(1);
  });
});

describe('bare directories (no git)', () => {
  it('runs orchestrator goals directly in a plain directory with a warning', async () => {
    const { bus, engine, events } = await makeHarness({ throws: false });
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-bare-'));
    const task = engine.createTask({
      goal: 'fix things in place',
      repoPath: dir,
      baseBranch: 'main',
      driver: 'opencode',
      orchestrate: true,
    });
    await engine.drain();

    expect(task.status).toBe('done');
    expect(task.bare).toBe(true);
    expect(task.worktreePath).toBe(dir); // agent ran in the directory itself
    expect(task.subtaskIds).toBeUndefined();
    const warns = events.filter((ev) => ev.kind === 'LogChunk');
    expect(warns.some((w) => w.payload.text.includes('not a git repo'))).toBe(true);
    void bus;
  });

  it('direct tasks in plain directories run in place without gates', async () => {
    const { engine } = await makeHarness({ throws: false });
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-bare2-'));
    const task = engine.createTask({
      goal: 'do the thing',
      repoPath: dir,
      baseBranch: 'main',
      driver: 'opencode',
    });
    await engine.drain();

    expect(task.status).toBe('done');
    expect(task.bare).toBe(true);
    expect(task.gates).toHaveLength(0); // no merge gate possible
  });
});
