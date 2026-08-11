import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '@fraktole/core';
import type { EventEnvelope, LimitsConfig } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import { Persistence, emptyState } from '../src/persistence.js';
import {
  NotCancellableError,
  PlanRejectedError,
  TaskEngine,
  type TaskHandlers,
} from '../src/task-engine.js';

const LIMITS: LimitsConfig = { maxConcurrent: 2, defaultTimeoutMs: 60_000, gateTimeoutMs: 30_000 };

async function makeEngine(handlers: TaskHandlers) {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-engine-'));
  const persist = new Persistence(dir);
  const bus = new EventBus();
  bus.onPublish = (ev) => void persist.append(ev.taskId ?? '_system', ev);
  const engine = new TaskEngine({ bus, handlers, limits: LIMITS });
  return { dir, bus, persist, engine };
}

async function readLog(dir: string, taskId: string): Promise<EventEnvelope[]> {
  const raw = await readFile(join(dir, 'tasks', `${taskId}.jsonl`), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

describe('TaskEngine lifecycle', () => {
  it('create -> queued -> planning -> (stub run fails) -> failed with exact event order', async () => {
    const { dir, engine, persist } = await makeEngine({
      plan: async () => ({ tasks: [], rationale: 'no subtasks' }),
      run: async () => {
        throw new Error('run step not implemented until Phase 4');
      },
    });
    const task = engine.createTask({
      goal: 'fix typo',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t1',
      driver: 'opencode',
    });
    await engine.drain();
    await persist.flush();

    expect(task.status).toBe('failed');
    const kinds = (await readLog(dir, task.id)).map((ev) => ev.kind);
    expect(kinds).toEqual(['TaskCreated', 'TaskPlanning', 'PlanReady', 'TaskRunning', 'TaskFailed']);
  });

  it('plan rejection requeues once, then fails on the second rejection', async () => {
    const { dir, engine, persist } = await makeEngine({
      plan: async () => {
        throw new PlanRejectedError('malformed plan');
      },
      run: async () => {},
    });
    const task = engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t2',
      driver: 'opencode',
    });
    await engine.drain();
    await persist.flush();

    expect(task.status).toBe('failed');
    const kinds = (await readLog(dir, task.id)).map((ev) => ev.kind);
    expect(kinds).toEqual([
      'TaskCreated',
      'TaskPlanning',
      'PlanRejected',
      'TaskQueued',
      'TaskPlanning',
      'PlanRejected',
      'TaskFailed',
    ]);
  });

  it('cancel works only on queued tasks', async () => {
    const { dir, engine, persist } = await makeEngine({
      plan: async () => ({ tasks: [], rationale: 'x' }),
      run: async () => {},
    });
    const t = engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t3',
      driver: 'opencode',
    });
    engine.cancelTask(t.id);
    await engine.drain();
    await persist.flush();

    expect(t.status).toBe('cancelled');
    expect((await readLog(dir, t.id)).map((ev) => ev.kind)).toEqual(['TaskCreated', 'TaskCancelled']);

    const finished = engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t4',
      driver: 'opencode',
    });
    await engine.drain();
    expect(() => engine.cancelTask(finished.id)).toThrow(NotCancellableError);
  });

  it('an illegal transition throws and emits nothing', async () => {
    const { dir, engine, persist } = await makeEngine({
      plan: async () => ({ tasks: [], rationale: 'x' }),
      run: async () => {},
    });
    const task = engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t5',
      driver: 'opencode',
    });
    await engine.drain();
    await persist.flush();
    const before = (await readLog(dir, task.id)).length;

    expect(() => engine.transition(task, 'running')).toThrow(IllegalTransitionError);
    await persist.flush();
    expect((await readLog(dir, task.id)).length).toBe(before);
  });

  it('restore re-enqueues queued tasks', async () => {
    const { engine } = await makeEngine({
      plan: async () => ({ tasks: [], rationale: 'x' }),
      run: async () => {},
    });
    engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t5b',
      driver: 'opencode',
    });
    await engine.drain();
    const state = emptyState();
    state.tasks = engine.getState().tasks;
    const t = Object.values(state.tasks)[0]!;
    t.status = 'queued';
    const engine2 = new TaskEngine({
      bus: new EventBus(),
      handlers: { plan: async () => null, run: async () => {} },
      limits: LIMITS,
    });
    engine2.restore(state);
    await engine2.drain();
    expect(engine2.getTask(t.id)?.status).not.toBe('queued');
  });
});

describe('Persistence round-trip', () => {
  it('restores identical task state from jsonl', async () => {
    const { dir, bus, engine, persist } = await makeEngine({
      plan: async () => ({ tasks: [], rationale: 'x' }),
      run: async () => {},
    });
    const task = engine.createTask({
      goal: 'g',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/t6',
      driver: 'opencode',
    });
    await engine.drain();
    await persist.flush();

    const restored = await new Persistence(dir).restore();
    expect(restored.tasks[task.id]?.status).toBe('done');
    expect(restored.lastSeq).toBe(bus.lastSeq);
  });

  it('replays a jsonl tail on top of a snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-persist-'));
    const persist = new Persistence(dir);
    const bus = new EventBus();
    const state = emptyState();
    state.tasks = {
      t1: {
        id: 't1',
        goal: 'g',
        repoPath: '/r',
        baseBranch: 'main',
        branch: 'fraktole/t1',
        driver: 'opencode',
        status: 'queued',
        statusSince: new Date().toISOString(),
        gates: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    await persist.snapshot(state);

    const ev = bus.publish('TaskPlanning', 't1', { taskId: 't1' });
    await persist.append('t1', ev);

    const restored = await new Persistence(dir).restore();
    expect(restored.tasks.t1?.status).toBe('planning');
    expect(restored.lastSeq).toBe(0);
  });

  it('recovers tasks from an orphan jsonl without a snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-persist-'));
    const persist = new Persistence(dir);
    const bus = new EventBus();
    const ev = bus.publish('TaskCreated', 't7', {
      task: {
        id: 't7',
        goal: 'g',
        repoPath: '/r',
        baseBranch: 'main',
        branch: 'fraktole/t7',
        driver: 'opencode',
        status: 'queued',
        statusSince: new Date().toISOString(),
        gates: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await persist.append('t7', ev);

    const restored = await new Persistence(dir).restore();
    expect(restored.tasks.t7?.status).toBe('queued');
    expect(restored.lastSeq).toBe(0);
  });
});
