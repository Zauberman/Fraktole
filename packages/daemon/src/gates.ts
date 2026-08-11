import type { GatesConfig, Task } from '@fraktole/core';
import type { EventBus } from './event-bus.js';
import type { TaskEngine } from './task-engine.js';
import { MergeConflictError, type WorktreeManager } from './worktrees.js';

export interface GateManagerDeps {
  worktrees: WorktreeManager;
  bus: EventBus;
  policy: GatesConfig;
}

export class GateManager {
  private engine?: TaskEngine;

  constructor(private readonly deps: GateManagerDeps) {}

  attachEngine(engine: TaskEngine): void {
    this.engine = engine;
  }

  /**
   * Requests the merge-to-base gate for a completed task. Commits the agent's
   * uncommitted worktree changes, then raises a blocking merge gate unless the
   * policy suppresses it or there is nothing to merge.
   */
  async requestMergeGate(task: Task): Promise<void> {
    if (!this.deps.policy.mergeToMain || !task.worktreePath) return;
    if (task.bare) return; // nothing to merge into: plain directory target
    const worktrees = this.deps.worktrees;
    await worktrees.commitWorktree(task.worktreePath, task.id);
    const diffStat = (await worktrees.diffStat(task.worktreePath, task.baseBranch)).trim();
    if (diffStat === '') return; // nothing to merge
    this.requireEngine().requestGate(
      task,
      'merge',
      `merge ${task.branch} into ${task.baseBranch}`,
      {
        branch: task.branch,
        diffStat,
        onApprove: async () => this.doMerge(task),
      },
    );
  }

  /** advisory checkpoint raised when an agent emits a FRAKTOLE-GATE marker */
  agentGate(task: Task, reason: string): void {
    this.requireEngine().requestGate(task, 'agent', reason, {
      blocking: false,
      branch: task.branch,
    });
  }

  private async doMerge(task: Task): Promise<boolean> {
    const worktrees = this.deps.worktrees;
    try {
      await worktrees.mergeBack(task.repoPath, task.id, task.baseBranch);
      this.deps.bus.publish('MergeDone', task.id, {
        taskId: task.id,
        branch: task.branch,
        target: task.baseBranch,
      });
      await worktrees.removeWorktree(task.repoPath, task.id);
      return true;
    } catch (err) {
      if (err instanceof MergeConflictError) {
        this.deps.bus.publish('MergeConflict', task.id, {
          taskId: task.id,
          branch: task.branch,
          target: task.baseBranch,
          details: err.stderr,
        });
      }
      return false;
    }
  }

  private requireEngine(): TaskEngine {
    if (!this.engine) throw new Error('GateManager not attached to an engine');
    return this.engine;
  }
}
