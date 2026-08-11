import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly stdout = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class MergeConflictError extends GitError {}

export interface WorktreeManagerOpts {
  worktreesDir: string;
}

/** true when `path` is inside a git working tree (toplevel resolvable) */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${e.message}`,
      e.stderr ?? '',
      e.stdout ?? '',
    );
  }
}

function taskBranch(taskId: string): string {
  return `fraktole/${taskId}`;
}

export class WorktreeManager {
  constructor(private readonly opts: WorktreeManagerOpts) {}

  async createWorktree(repoPath: string, taskId: string, baseBranch: string): Promise<string> {
    await mkdir(this.opts.worktreesDir, { recursive: true });
    const path = join(this.opts.worktreesDir, taskId);
    await git(['worktree', 'add', '-b', taskBranch(taskId), path, baseBranch], repoPath);
    return path;
  }

  /**
   * Squash-merges the task branch into baseBranch without touching the user's
   * main checkout: work in a detached throwaway worktree at baseBranch's tip,
   * then fast-forward the baseBranch ref.
   */
  async mergeBack(repoPath: string, taskId: string, baseBranch: string): Promise<void> {
    const branch = taskBranch(taskId);
    const tmp = join(this.opts.worktreesDir, `merge-${taskId}`);
    try {
      await git(['worktree', 'add', '--detach', tmp, baseBranch], repoPath);
      await git(['merge', '--squash', branch], tmp);
      try {
        await git(['commit', '-m', `fraktole: merge task ${taskId} into ${baseBranch}`], tmp);
      } catch (err) {
        if (
          err instanceof GitError &&
          (/nothing to commit/i.test(err.stderr) || /nothing to commit/i.test(err.stdout))
        ) {
          return; // task produced no changes; baseBranch is already current
        }
        throw err;
      }
      await git(['update-ref', `refs/heads/${baseBranch}`, 'HEAD'], tmp);
    } catch (err) {
      if (err instanceof GitError && /conflict/i.test(`${err.stderr}\n${err.stdout}`)) {
        throw new MergeConflictError(
          `merge conflict merging ${branch} into ${baseBranch}`,
          err.stderr,
          err.stdout,
        );
      }
      throw err;
    } finally {
      try {
        await git(['worktree', 'remove', '--force', tmp], repoPath);
      } catch {
        // cleanup best-effort; the worktree remains for manual resolution
      }
    }
  }

  /** commits the worktree's working-tree changes on the task branch; no-op when clean */
  async commitWorktree(worktreePath: string, taskId: string): Promise<void> {
    try {
      await git(['add', '-A'], worktreePath);
      await git(['commit', '-m', `fraktole: task ${taskId}`], worktreePath);
    } catch (err) {
      if (
        err instanceof GitError &&
        (/nothing to commit/i.test(err.stderr) || /nothing to commit/i.test(err.stdout))
      ) {
        return;
      }
      throw err;
    }
  }

  /** human-readable diff summary of the task branch vs its base (three-dot) */
  async diffStat(worktreePath: string, baseBranch: string): Promise<string> {
    return git(['diff', '--stat', `${baseBranch}...HEAD`], worktreePath).catch(() => '');
  }

  async removeWorktree(repoPath: string, taskId: string): Promise<void> {
    const path = join(this.opts.worktreesDir, taskId);
    try {
      await git(['worktree', 'remove', '--force', path], repoPath);
    } catch {
      // missing worktree is fine
    }
    await git(['branch', '-D', taskBranch(taskId)], repoPath).catch(() => undefined);
  }
}
