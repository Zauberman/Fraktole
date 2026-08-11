import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, type EventKind, type EventPayloads } from '../src/events.js';
import { createTask } from '../src/tasks.js';

const task = createTask({
  goal: 'goal',
  repoPath: '/repo',
  baseBranch: 'main',
  branch: 'fraktole/t1',
  driver: 'opencode',
});

describe('event contract', () => {
  it('defines a payload type for every event kind', () => {
    const now = new Date().toISOString();
    const payloads: Record<EventKind, EventPayloads[EventKind]> = {
      DaemonStarted: { version: '0.1.0', pid: 1 },
      StateRestored: { taskCount: 0, lastSeq: 0 },
      TaskCreated: { task },
      TaskQueued: { taskId: task.id },
      TaskPlanning: { taskId: task.id },
      PlanReady: { taskId: task.id, plan: { tasks: [], rationale: 'r' } },
      PlanRejected: { taskId: task.id, reason: 'x' },
      TaskRunning: { taskId: task.id, worktreePath: '/wt' },
      AgentSpawned: { taskId: task.id, driver: 'opencode', pid: 42 },
      LogChunk: { taskId: task.id, stream: 'stdout', text: 'hi' },
      AgentExited: { taskId: task.id, exitCode: 0, signal: null },
      GateRequested: {
        gateId: 'g1',
        taskId: task.id,
        kind: 'merge',
        reason: 'merge to main',
        branch: 'fraktole/t1',
        diffStat: '1 file changed',
      },
      GateResolved: { gateId: 'g1', decision: 'approve', resolvedBy: 'test', at: now },
      TaskDone: { taskId: task.id },
      TaskFailed: { taskId: task.id, reason: 'x' },
      TaskCancelled: { taskId: task.id },
      MergeStarted: { taskId: task.id, branch: 'fraktole/t1', target: 'main' },
      MergeDone: { taskId: task.id, branch: 'fraktole/t1', target: 'main' },
      MergeConflict: {
        taskId: task.id,
        branch: 'fraktole/t1',
        target: 'main',
        details: 'CONFLICT',
      },
    };
    expect(Object.keys(payloads).sort()).toEqual([...EVENT_KINDS].sort());
  });
});
