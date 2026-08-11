import type { GateKind, GateDecision, Task, TaskPlan } from './tasks.js';

export const EVENT_KINDS = [
  'DaemonStarted',
  'StateRestored',
  'TaskCreated',
  'TaskQueued',
  'TaskPlanning',
  'PlanReady',
  'PlanRejected',
  'TaskRunning',
  'AgentSpawned',
  'LogChunk',
  'AgentExited',
  'GateRequested',
  'GateResolved',
  'TaskDone',
  'TaskFailed',
  'TaskCancelled',
  'MergeStarted',
  'MergeDone',
  'MergeConflict',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventPayloads {
  DaemonStarted: { version: string; pid: number };
  StateRestored: { taskCount: number; lastSeq: number };
  TaskCreated: { task: Task };
  TaskQueued: { taskId: string };
  TaskPlanning: { taskId: string };
  PlanReady: { taskId: string; plan: TaskPlan };
  PlanRejected: { taskId: string; reason: string };
  TaskRunning: { taskId: string; worktreePath: string };
  AgentSpawned: { taskId: string; driver: string; pid: number };
  LogChunk: { taskId: string; stream: 'stdout' | 'stderr'; text: string };
  AgentExited: { taskId: string; exitCode: number | null; signal: string | null };
  GateRequested: {
    gateId: string;
    taskId: string;
    kind: GateKind;
    reason: string;
    branch?: string;
    diffStat?: string;
  };
  GateResolved: { gateId: string; decision: GateDecision; resolvedBy: string; at: string };
  TaskDone: { taskId: string };
  TaskFailed: { taskId: string; reason: string };
  TaskCancelled: { taskId: string };
  MergeStarted: { taskId: string; branch: string; target: string };
  MergeDone: { taskId: string; branch: string; target: string };
  MergeConflict: { taskId: string; branch: string; target: string; details: string };
}

type EnvelopeFor<K extends EventKind> = {
  id: string;
  ts: string;
  kind: K;
  taskId?: string;
  payload: EventPayloads[K];
  seq: number;
};

export type { EnvelopeFor };

export type EventEnvelope = { [K in EventKind]: EnvelopeFor<K> }[EventKind];

export function makeEnvelope<K extends EventKind>(
  kind: K,
  taskId: string | undefined,
  payload: EventPayloads[K],
  seq: number,
): EnvelopeFor<K> {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    kind,
    taskId,
    payload,
    seq,
  };
}
