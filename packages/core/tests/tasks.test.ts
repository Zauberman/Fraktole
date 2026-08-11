import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  TASK_STATUSES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  createTask,
  type TaskStatus,
} from '../src/tasks.js';

const EXPECTED: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'cancelled'],
  planning: ['queued', 'running', 'failed'],
  running: ['gating', 'merging', 'done', 'failed', 'cancelled'],
  gating: ['running', 'merging', 'failed', 'cancelled'],
  merging: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

describe('task state machine', () => {
  it('full transition matrix matches the contract', () => {
    for (const from of TASK_STATUSES) {
      const allowed = TASK_STATUSES.filter((to) => canTransition(from, to));
      expect(allowed.sort()).toEqual([...EXPECTED[from]].sort());
      expect([...TRANSITIONS[from]].sort()).toEqual([...EXPECTED[from]].sort());
    }
  });

  it('assertTransition throws on illegal moves and passes legal ones', () => {
    expect(() => assertTransition('done', 'running')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('queued', 'running')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('cancelled', 'planning')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('running', 'gating')).not.toThrow();
    expect(() => assertTransition('gating', 'running')).not.toThrow();
  });
});

describe('createTask', () => {
  it('creates a queued task with the given identity fields', () => {
    const task = createTask({
      goal: 'fix typo',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'fraktole/abc',
      driver: 'opencode',
      parentTaskId: 'parent-1',
    });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status).toBe('queued');
    expect(task.gates).toEqual([]);
    expect(task.pid).toBeUndefined();
    expect(task.worktreePath).toBeUndefined();
    expect(task.parentTaskId).toBe('parent-1');
    expect(task.createdAt).toBe(task.statusSince);
    expect(task.updatedAt).toBe(task.createdAt);
  });
});
