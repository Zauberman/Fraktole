export type GateKind = 'plan-step' | 'merge' | 'agent' | 'destructive-command';
export type GateDecision = 'approve' | 'deny';
export type GateStatus = 'open' | 'approved' | 'denied' | 'timed_out';

export interface GateRecord {
  id: string;
  kind: GateKind;
  reason: string;
  status: GateStatus;
  requestedAt: string;
  branch?: string;
  diffStat?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface PlannedTask {
  title: string;
  repo: string;
  baseBranch: string;
  driver: string;
  goal: string;
  needsGate: boolean;
  gateReason?: string;
}

export interface TaskPlan {
  tasks: PlannedTask[];
  rationale: string;
}

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'gating'
  | 'merging'
  | 'done'
  | 'failed'
  | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'planning',
  'running',
  'gating',
  'merging',
  'done',
  'failed',
  'cancelled',
];

export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['planning', 'cancelled'],
  planning: ['queued', 'running', 'failed'],
  running: ['gating', 'merging', 'done', 'failed', 'cancelled'],
  gating: ['running', 'merging', 'failed', 'cancelled'],
  merging: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export interface Task {
  id: string;
  goal: string;
  repoPath: string;
  baseBranch: string;
  branch: string;
  driver: string;
  status: TaskStatus;
  statusSince: string;
  worktreePath?: string;
  plan?: TaskPlan;
  parentTaskId?: string;
  subtaskIds?: string[];
  orchestrate?: boolean;
  /** target directory is not a git repo: the agent runs in place, no worktree/merge */
  bare?: boolean;
  pid?: number;
  exitCode?: number | null;
  gates: GateRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  goal: string;
  repoPath: string;
  baseBranch: string;
  branch?: string;
  driver: string;
  plan?: TaskPlan;
  parentTaskId?: string;
  orchestrate?: boolean;
}

export function createTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    goal: input.goal,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    branch: input.branch ?? `fraktole/${id}`,
    driver: input.driver,
    status: 'queued',
    statusSince: now,
    plan: input.plan,
    parentTaskId: input.parentTaskId,
    orchestrate: input.orchestrate,
    gates: [],
    createdAt: now,
    updatedAt: now,
  };
}
