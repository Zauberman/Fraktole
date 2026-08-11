import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LimitsConfig, Task } from '@fraktole/core';
import { EventBus } from '../src/event-bus.js';
import { Persistence } from '../src/persistence.js';
import { PlanRejectedError, TaskEngine, type TaskHandlers } from '../src/task-engine.js';

const LIMITS: LimitsConfig = { maxConcurrent: 2, defaultTimeoutMs: 60_000, gateTimeoutMs: 30_000 };

async function makeEngine(handlers: TaskHandlers) {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-orch-'));
  const persist = new Persistence(dir);
  const bus = new EventBus();
  bus.onPublish = (ev) => void persist.append(ev.taskId ?? '_system', ev);
  const engine = new TaskEngine({ bus, handlers, limits: LIMITS });
  return { dir, bus, persist, engine };
}

function planOnlyWhenOrchestrator(
  plan: (task: Task) => ReturnType<TaskHandlers['plan']>,
): TaskHandlers['plan'] {
  return (task) => {
    if (!task.orchestrate) return Promise.resolve({ tasks: [], rationale: 'direct task' });
    return plan(task);
  };
}

function twoSubtasks(): TaskHandlers {
  return {
    plan: planOnlyWhenOrchestrator(async () => ({
      rationale: 'two pieces',
      tasks: [
        { title: 'a', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'do a', needsGate: false },
        { title: 'b', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'do b', needsGate: false },
      ],
    })),
    run: async (task) => {
      task.exitCode = 0;
    },
  };
}

function createParent(engine: TaskEngine, goal = 'big goal') {
  return engine.createTask({
    goal,
    repoPath: '/r',
    baseBranch: 'main',
    driver: 'opencode',
    orchestrate: true,
  });
}

describe('TaskEngine orchestration', () => {
  it('decomposes an orchestrator task into parallel subtasks', async () => {
    const { engine } = await makeEngine(twoSubtasks());
    const parent = createParent(engine);
    await engine.drain();

    expect(parent.status).toBe('done');
    expect(parent.subtaskIds).toHaveLength(2);
    for (const id of parent.subtaskIds!) {
      const sub = engine.getTask(id)!;
      expect(sub.parentTaskId).toBe(parent.id);
      expect(sub.status).toBe('done');
    }
  });

  it('marks the parent failed when a subtask fails', async () => {
    const { engine } = await makeEngine({
      plan: planOnlyWhenOrchestrator(async () => ({
        rationale: 'one fails',
        tasks: [
          { title: 'good', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'ok', needsGate: false },
          { title: 'bad', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'nope', needsGate: false },
        ],
      })),
      run: async (task) => {
        if (task.goal === 'nope') throw new Error('agent failed');
        task.exitCode = 0;
      },
    });
    const parent = createParent(engine);
    await engine.drain();

    expect(parent.status).toBe('failed');
    const subStatuses = parent.subtaskIds!.map((id) => engine.getTask(id)!.status);
    expect(subStatuses).toContain('done');
    expect(subStatuses).toContain('failed');
  });

  it('holds needsGate subtasks in gating until approved, then runs them', async () => {
    const { engine } = await makeEngine({
      plan: planOnlyWhenOrchestrator(async () => ({
        rationale: 'gated',
        tasks: [
          {
            title: 'risky',
            repo: '/r',
            baseBranch: 'main',
            driver: 'opencode',
            goal: 'danger',
            needsGate: true,
            gateReason: 'could delete data',
          },
        ],
      })),
      run: async (task) => {
        task.exitCode = 0;
      },
    });
    const parent = createParent(engine);
    await engine.drain();

    const sub = engine.getTask(parent.subtaskIds![0]!)!;
    expect(sub.status).toBe('gating');
    expect(sub.gates[0]?.kind).toBe('plan-step');
    expect(sub.gates[0]?.status).toBe('open');
    expect(parent.status).toBe('running');

    engine.resolveGate(sub.gates[0]!.id, 'approve');
    await engine.drain();

    expect(sub.status).toBe('done');
    expect(parent.status).toBe('done');
  });

  it('fails a gated subtask when the gate is denied', async () => {
    const { engine } = await makeEngine({
      plan: planOnlyWhenOrchestrator(async () => ({
        rationale: 'gated',
        tasks: [
          { title: 'risky', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'danger', needsGate: true },
        ],
      })),
      run: async () => {},
    });
    const parent = createParent(engine);
    await engine.drain();
    const sub = engine.getTask(parent.subtaskIds![0]!)!;

    engine.resolveGate(sub.gates[0]!.id, 'deny');
    await engine.drain();

    expect(sub.status).toBe('failed');
    expect(parent.status).toBe('failed');
  });

  it('cancels a gated task and reconciles the parent', async () => {
    const { engine } = await makeEngine({
      plan: planOnlyWhenOrchestrator(async () => ({
        rationale: 'gated',
        tasks: [
          { title: 'risky', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'danger', needsGate: true },
          { title: 'plain', repo: '/r', baseBranch: 'main', driver: 'opencode', goal: 'ok', needsGate: false },
        ],
      })),
      run: async (task) => {
        task.exitCode = 0;
      },
    });
    const parent = createParent(engine);
    await engine.drain();

    const gated = engine.getTask(parent.subtaskIds![0]!)!;
    engine.cancelTask(gated.id);
    await engine.drain();

    expect(gated.status).toBe('cancelled');
    expect(parent.status).toBe('failed');
  });

  it('rejects a planner failure once, then fails the orchestrator task', async () => {
    const { engine } = await makeEngine({
      plan: async () => {
        throw new PlanRejectedError('planner is down');
      },
      run: async () => {},
    });
    const parent = createParent(engine);
    await engine.drain();

    expect(parent.status).toBe('failed');
    expect(parent.subtaskIds).toBeUndefined();
  });
});
