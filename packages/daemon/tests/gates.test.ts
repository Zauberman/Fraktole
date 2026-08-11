import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { GatesConfig, LimitsConfig } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import { GateManager } from '../src/gates.js';
import { TaskEngine, type TaskHandlers } from '../src/task-engine.js';
import { WorktreeManager } from '../src/worktrees.js';

const execFileP = promisify(execFile);

const LIMITS: LimitsConfig = { maxConcurrent: 2, defaultTimeoutMs: 60_000, gateTimeoutMs: 30_000 };
const POLICY: GatesConfig = {
  mergeToMain: true,
  destructiveCommands: true,
  externalNetwork: false,
  heavyActions: false,
};

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fraktole-gates-repo-'));
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await writeFile(join(repo, 'README.md'), '# R\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'init'], repo);
  return repo;
}

async function makeHarness(
  policy: GatesConfig = POLICY,
  gateTimeoutMs = 30_000,
  agentWork?: (worktreePath: string) => Promise<void>,
) {
  const repo = await makeRepo();
  const wts = await mkdtemp(join(tmpdir(), 'fraktole-gates-wts-'));
  const worktrees = new WorktreeManager({ worktreesDir: wts });
  const bus = new EventBus();
  const gates = new GateManager({ worktrees, bus, policy });
  const handlers: TaskHandlers = {
    plan: async () => ({ tasks: [], rationale: 'direct' }),
    run: async (task) => {
      task.worktreePath = await worktrees.createWorktree(task.repoPath, task.id, task.baseBranch);
      if (agentWork) await agentWork(task.worktreePath);
      task.exitCode = 0;
      // the merge gate is raised by the handler while the task is still 'running'
      await gates.requestMergeGate(task);
    },
  };
  const engine = new TaskEngine({ bus, handlers, limits: { ...LIMITS, gateTimeoutMs } });
  gates.attachEngine(engine);
  return { repo, wts, worktrees, bus, gates, engine };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('GateManager merge gates', () => {
  it('raises a merge gate with a diff summary and merges on approval', async () => {
    const { repo, wts, engine } = await makeHarness(POLICY, 30_000, async (wt) => {
      await writeFile(join(wt, 'feature.txt'), 'feat\n');
    });
    const task = engine.createTask({ goal: 'g', repoPath: repo, baseBranch: 'main', driver: 'opencode' });
    await engine.drain();

    expect(task.status).toBe('gating');
    const gate = task.gates[0]!;
    expect(gate.kind).toBe('merge');
    expect(gate.diffStat).toContain('feature.txt');

    engine.resolveGate(gate.id, 'approve');
    await engine.drain();

    expect(task.status).toBe('done');
    expect((await git(['show', 'main:feature.txt'], repo)).trim()).toBe('feat');
    const list = await git(['worktree', 'list'], repo);
    expect(list).not.toContain(wts);
  });

  it('skips the gate entirely when policy suppresses merging', async () => {
    const { repo, engine } = await makeHarness({ ...POLICY, mergeToMain: false }, 30_000, async (wt) => {
      await writeFile(join(wt, 'x.txt'), 'x\n');
    });
    const task = engine.createTask({ goal: 'g', repoPath: repo, baseBranch: 'main', driver: 'opencode' });
    await engine.drain();

    expect(task.status).toBe('done');
    expect(task.gates).toHaveLength(0);
  });

  it('auto-denies an open gate after the gate timeout', async () => {
    const { repo, engine } = await makeHarness(POLICY, 150, async (wt) => {
      await writeFile(join(wt, 'x.txt'), 'x\n');
    });
    const task = engine.createTask({ goal: 'g', repoPath: repo, baseBranch: 'main', driver: 'opencode' });
    await engine.drain();

    await waitFor(() => task.status === 'failed', 3000);
    expect(task.gates[0]?.status).toBe('timed_out');
  });

  it('reports a merge conflict as a failed task', async () => {
    const { repo, engine } = await makeHarness(POLICY, 30_000, async (wt) => {
      await writeFile(join(wt, 'README.md'), 'worktree edit\n');
    });
    const task = engine.createTask({ goal: 'g', repoPath: repo, baseBranch: 'main', driver: 'opencode' });
    await engine.drain();

    // advance the base branch after the worktree diverged
    await writeFile(join(repo, 'README.md'), 'base edit\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'base'], repo);

    engine.resolveGate(task.gates[0]!.id, 'approve');
    await engine.drain();

    expect(task.status).toBe('failed');
    expect(task.gates[0]?.status).toBe('approved');
  });
});
