import {
  assertTransition,
  createTask,
  type CreateTaskInput,
  type EventEnvelope,
  type GateDecision,
  type GateKind,
  type GateRecord,
  type LimitsConfig,
  type PlannedTask,
  type Task,
  type TaskPlan,
  type TaskStatus,
} from '@fraktole/core';
import type { EventBus } from './event-bus.js';
import type { EngineState } from './persistence.js';

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class NotCancellableError extends Error {
  constructor(taskId: string, status: TaskStatus) {
    super(`task ${taskId} cannot be cancelled from status ${status}`);
    this.name = 'NotCancellableError';
  }
}

export class PlanRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PlanRejectedError';
  }
}

export class PlanParseError extends PlanRejectedError {
  constructor(reason: string) {
    super(reason);
    this.name = 'PlanParseError';
  }
}

export interface TaskHandlers {
  plan(task: Task): Promise<TaskPlan | null>;
  run(task: Task): Promise<void>;
}

const MAX_PLAN_ATTEMPTS = 2;

export class TaskEngine {
  private state: EngineState = { version: 1, lastSeq: -1, tasks: {} };
  private queue: string[] = [];
  private pumping = false;
  private activity: Promise<unknown> = Promise.resolve();
  private planAttempts = new Map<string, number>();
  private gateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private approveActions = new Map<string, () => Promise<boolean>>();
  private readonly bus: EventBus;
  private readonly handlers: TaskHandlers;
  private readonly limits: LimitsConfig;
  private readonly gateTimeoutMs: number;

  constructor(deps: { bus: EventBus; handlers: TaskHandlers; limits: LimitsConfig }) {
    this.bus = deps.bus;
    this.handlers = deps.handlers;
    this.limits = deps.limits;
    this.gateTimeoutMs = deps.limits.gateTimeoutMs ?? 0;
  }

  getState(): EngineState {
    return this.state;
  }

  restore(state: EngineState): void {
    this.state = state;
    this.queue = Object.values(state.tasks)
      .filter((t) => t.status === 'queued')
      .map((t) => t.id);
    void this.schedule(() => this.pump());
  }

  createTask(input: CreateTaskInput): Task {
    const task = createTask(input);
    this.state.tasks[task.id] = task;
    this.bus.publish('TaskCreated', task.id, { task });
    this.queue.push(task.id);
    void this.schedule(() => this.pump());
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.state.tasks[id];
  }

  listTasks(): Task[] {
    return Object.values(this.state.tasks);
  }

  cancelTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    if (task.status !== 'queued' && task.status !== 'gating') {
      throw new NotCancellableError(id, task.status);
    }
    this.transition(task, 'cancelled');
    this.bus.publish('TaskCancelled', id, { taskId: id });
    this.queue = this.queue.filter((q) => q !== id);
    this.cancelGateTimers(task.id);
    this.onSubtaskTerminal(task);
  }

  public requestGate(
    task: Task,
    kind: GateKind,
    reason: string,
    opts: {
      blocking?: boolean;
      branch?: string;
      diffStat?: string;
      /** invoked by the engine on approval; return false to fail the task */
      onApprove?: () => Promise<boolean>;
    } = {},
  ): string {
    const blocking = opts.blocking ?? true;
    if (blocking) {
      if (task.status === 'queued') {
        // queued -> planning -> running -> gating: the machine has no direct
        // queued/planning -> gating edge; gating is a halt on a running task.
        this.transition(task, 'planning');
        this.bus.publish('TaskPlanning', task.id, { taskId: task.id });
        this.transition(task, 'running');
        this.bus.publish('TaskRunning', task.id, { taskId: task.id, worktreePath: '' });
      }
      if (task.status === 'running') {
        this.transition(task, 'gating');
      }
    }
    const gate: GateRecord = {
      id: crypto.randomUUID(),
      kind,
      reason,
      status: 'open',
      requestedAt: new Date().toISOString(),
      branch: opts.branch,
      diffStat: opts.diffStat,
    };
    task.gates.push(gate);
    this.bus.publish('GateRequested', task.id, {
      gateId: gate.id,
      taskId: task.id,
      kind,
      reason,
      branch: opts.branch,
      diffStat: opts.diffStat,
    });
    if (this.gateTimeoutMs > 0) {
      const timer = setTimeout(() => {
        this.resolveGate(gate.id, 'deny', 'gate-timeout', true);
      }, this.gateTimeoutMs);
      this.gateTimers.set(gate.id, timer);
    }
    if (blocking && opts.onApprove) {
      this.approveActions.set(gate.id, opts.onApprove);
    }
    return gate.id;
  }

  resolveGate(gateId: string, decision: GateDecision, resolvedBy = 'user', timedOut = false): void {
    for (const task of Object.values(this.state.tasks)) {
      const gate = task.gates.find((g) => g.id === gateId);
      if (!gate || gate.status !== 'open') continue;
      const now = new Date().toISOString();
      const timer = this.gateTimers.get(gate.id);
      if (timer) clearTimeout(timer);
      this.gateTimers.delete(gate.id);
      gate.status = timedOut ? 'timed_out' : decision === 'approve' ? 'approved' : 'denied';
      gate.resolvedAt = now;
      gate.resolvedBy = resolvedBy;
      this.bus.publish('GateResolved', task.id, { gateId, decision, resolvedBy, at: now });
      if (decision === 'deny') {
        if (task.status === 'gating') {
          this.fail(task, timedOut ? `gate timed out after ${this.gateTimeoutMs}ms` : 'gate denied');
          this.onSubtaskTerminal(task);
        }
        return;
      }
      if (task.status === 'gating') {
        const action = this.approveActions.get(gate.id);
        this.approveActions.delete(gate.id);
        if (action) {
          this.transition(task, 'merging');
          this.bus.publish('MergeStarted', task.id, {
            taskId: task.id,
            branch: task.branch,
            target: task.baseBranch,
          });
          void this.schedule(async () => {
            const ok = await action();
            if (ok) {
              this.transition(task, 'done');
              this.bus.publish('TaskDone', task.id, { taskId: task.id });
              this.onSubtaskTerminal(task);
            } else {
              this.fail(task, 'merge failed');
              this.onSubtaskTerminal(task);
            }
            void this.schedule(() => this.pump());
          });
        } else {
          this.transition(task, 'running');
          this.bus.publish('TaskRunning', task.id, {
            taskId: task.id,
            worktreePath: task.worktreePath ?? '',
          });
          void this.schedule(() => this.runTask(task));
        }
      }
      return;
    }
    throw new TaskNotFoundError(`gate ${gateId}`);
  }

  private cancelGateTimers(taskId: string): void {
    for (const [gateId, timer] of this.gateTimers) {
      const task = this.getTask(taskId);
      if (task?.gates.some((g) => g.id === gateId)) {
        clearTimeout(timer);
        this.gateTimers.delete(gateId);
      }
    }
  }

  transition(task: Task, to: TaskStatus): void {
    assertTransition(task.status, to);
    const now = new Date().toISOString();
    task.status = to;
    task.statusSince = now;
    task.updatedAt = now;
  }

  async drain(): Promise<void> {
    for (;;) {
      const current = this.activity;
      await current;
      if (this.activity === current) return;
    }
  }

  private schedule(work: () => Promise<void>): void {
    this.activity = this.activity.then(work, work);
  }

  private runningCount(): number {
    return Object.values(this.state.tasks).filter((t) => t.status === 'running').length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.runningCount() < this.limits.maxConcurrent) {
        const id = this.queue.shift();
        if (!id) break;
        const task = this.state.tasks[id];
        if (!task || task.status !== 'queued') continue;
        void this.schedule(() => this.advance(task));
      }
    } finally {
      this.pumping = false;
    }
  }

  private async advance(task: Task): Promise<void> {
    this.transition(task, 'planning');
    this.bus.publish('TaskPlanning', task.id, { taskId: task.id });
    let plan: TaskPlan | null;
    try {
      plan = await this.handlers.plan(task);
    } catch (err) {
      if (err instanceof PlanRejectedError) {
        this.rejectAndRequeue(task, err.message);
        return;
      }
      this.fail(task, `planning failed: ${messageOf(err)}`);
      return;
    }
    if (plan === null) {
      this.rejectAndRequeue(task, 'plan handler returned null');
      return;
    }
    task.plan = plan;
    this.bus.publish('PlanReady', task.id, { taskId: task.id, plan });
    if (plan.tasks.length > 0) {
      this.decompose(task, plan.tasks);
      return;
    }

    this.transition(task, 'running');
    this.bus.publish('TaskRunning', task.id, {
      taskId: task.id,
      worktreePath: task.worktreePath ?? '',
    });
    await this.runTask(task);
  }

  private async runTask(task: Task): Promise<void> {
    try {
      await this.handlers.run(task);
      // the handler may have left the task in 'gating' (merge gate) or 'merging';
      // only complete it if it is still running.
      if (task.status === 'running') {
        this.transition(task, 'done');
        this.bus.publish('TaskDone', task.id, { taskId: task.id });
        this.onSubtaskTerminal(task);
      }
    } catch (err) {
      this.fail(task, messageOf(err));
      this.onSubtaskTerminal(task);
    }
    // a slot freed: let queued siblings proceed
    void this.schedule(() => this.pump());
  }

  private decompose(task: Task, items: PlannedTask[]): void {
    const subtaskIds: string[] = [];
    for (const item of items) {
      const sub = createTask({
        goal: item.goal,
        repoPath: item.repo,
        baseBranch: item.baseBranch,
        driver: item.driver,
        parentTaskId: task.id,
      });
      this.state.tasks[sub.id] = sub;
      subtaskIds.push(sub.id);
      this.bus.publish('TaskCreated', sub.id, { task: sub });
      if (item.needsGate) {
        this.requestGate(sub, 'plan-step', item.gateReason ?? 'plan step requires approval', {
          branch: sub.branch,
        });
      } else {
        this.queue.push(sub.id);
      }
    }
    task.subtaskIds = subtaskIds;
    this.transition(task, 'running');
    this.bus.publish('TaskRunning', task.id, { taskId: task.id, worktreePath: '' });
    void this.schedule(() => this.pump());
  }

  private onSubtaskTerminal(sub: Task): void {
    if (!sub.parentTaskId) return;
    const parent = this.state.tasks[sub.parentTaskId];
    if (!parent || parent.status !== 'running') return;
    const subs = parent.subtaskIds ?? [];
    if (subs.length === 0) return;
    const allTerminal = subs.every((id) => {
      const t = this.state.tasks[id];
      return t !== undefined && ['done', 'failed', 'cancelled'].includes(t.status);
    });
    if (!allTerminal) return;
    const anyBad = subs.some((id) => {
      const status = this.state.tasks[id]?.status;
      return status === 'failed' || status === 'cancelled';
    });
    if (anyBad) {
      this.fail(parent, 'one or more subtasks failed');
    } else {
      this.transition(parent, 'done');
      this.bus.publish('TaskDone', parent.id, { taskId: parent.id });
    }
  }

  private rejectAndRequeue(task: Task, reason: string): void {
    const attempts = (this.planAttempts.get(task.id) ?? 0) + 1;
    this.planAttempts.set(task.id, attempts);
    this.bus.publish('PlanRejected', task.id, { taskId: task.id, reason });
    if (attempts >= MAX_PLAN_ATTEMPTS) {
      this.fail(task, `plan rejected: ${reason}`);
      return;
    }
    this.transition(task, 'queued');
    this.bus.publish('TaskQueued', task.id, { taskId: task.id });
    this.queue.push(task.id);
    void this.schedule(() => this.pump());
  }

  private fail(task: Task, reason: string): void {
    if (task.status === 'failed') return;
    if (
      task.status === 'planning' ||
      task.status === 'running' ||
      task.status === 'gating' ||
      task.status === 'merging'
    ) {
      this.transition(task, 'failed');
    }
    this.bus.publish('TaskFailed', task.id, { taskId: task.id, reason });
  }
}

export function applyEventToState(state: EngineState, ev: EventEnvelope): void {
  state.lastSeq = Math.max(state.lastSeq, ev.seq);
  const task = ev.taskId ? (state.tasks[ev.taskId] ?? undefined) : undefined;
  switch (ev.kind) {
    case 'TaskCreated':
      state.tasks[ev.payload.task.id] = ev.payload.task;
      break;
    case 'TaskQueued':
      if (task) setStatus(task, 'queued', ev.ts);
      break;
    case 'TaskPlanning':
      if (task) setStatus(task, 'planning', ev.ts);
      break;
    case 'PlanReady':
      if (task) task.plan = ev.payload.plan;
      break;
    case 'TaskRunning':
      if (task) {
        setStatus(task, 'running', ev.ts);
        if (ev.payload.worktreePath) task.worktreePath = ev.payload.worktreePath;
      }
      break;
    case 'AgentSpawned':
      if (task) task.pid = ev.payload.pid;
      break;
    case 'AgentExited':
      if (task) task.exitCode = ev.payload.exitCode;
      break;
    case 'GateRequested':
      if (task) {
        task.gates.push({
          id: ev.payload.gateId,
          kind: ev.payload.kind,
          reason: ev.payload.reason,
          status: 'open',
          requestedAt: ev.ts,
        });
      }
      break;
    case 'GateResolved':
      if (task) {
        const gate = task.gates.find((g) => g.id === ev.payload.gateId);
        if (gate) {
          gate.status = ev.payload.decision === 'approve' ? 'approved' : 'denied';
          gate.resolvedAt = ev.payload.at;
          gate.resolvedBy = ev.payload.resolvedBy;
        }
      }
      break;
    case 'TaskDone':
    case 'MergeDone':
      if (task) setStatus(task, 'done', ev.ts);
      break;
    case 'TaskFailed':
    case 'MergeConflict':
      if (task) setStatus(task, 'failed', ev.ts);
      break;
    case 'TaskCancelled':
      if (task) setStatus(task, 'cancelled', ev.ts);
      break;
    case 'MergeStarted':
      if (task) setStatus(task, 'merging', ev.ts);
      break;
    default:
      break;
  }
}

function setStatus(task: Task, status: TaskStatus, ts: string): void {
  if (task.status === status) return;
  assertTransition(task.status, status);
  task.status = status;
  task.statusSince = ts;
  task.updatedAt = ts;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
