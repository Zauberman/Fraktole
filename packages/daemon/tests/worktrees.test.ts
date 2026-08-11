import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MergeConflictError, WorktreeManager } from '../src/worktrees.js';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fraktole-repo-'));
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@fraktole'], repo);
  await git(['config', 'user.name', 'Fraktole Test'], repo);
  await writeFile(join(repo, 'README.md'), '# Scratch\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'initial'], repo);
  return repo;
}

async function makeWm(): Promise<{ repo: string; wm: WorktreeManager }> {
  const repo = await makeRepo();
  const wts = await mkdtemp(join(tmpdir(), 'fraktole-wts-'));
  return { repo, wm: new WorktreeManager({ worktreesDir: wts }) };
}

describe('WorktreeManager', () => {
  it('creates a worktree on a task branch', async () => {
    const { repo, wm } = await makeWm();
    const path = await wm.createWorktree(repo, 't1', 'main');
    expect(path).toContain('fraktole-wts-');
    const branches = await git(['branch', '--list', 'fraktole/t1'], repo);
    // the '+' prefix marks a branch checked out in another worktree
    expect(branches.trim().replace(/^\+ /, '')).toBe('fraktole/t1');
  });

  it('squash-merges task changes back into the base branch', async () => {
    const { repo, wm } = await makeWm();
    const path = await wm.createWorktree(repo, 't2', 'main');
    await writeFile(join(path, 'feature.txt'), 'feature\n');
    await git(['add', '.'], path);
    await git(['commit', '-m', 'task work'], path);

    await wm.mergeBack(repo, 't2', 'main');
    const content = await git(['show', 'main:feature.txt'], repo);
    expect(content).toBe('feature\n');
    const mainLog = await git(['log', '--oneline', 'main'], repo);
    expect(mainLog.trim().split('\n')).toHaveLength(2);
  });

  it('treats an empty task branch as a successful no-op merge', async () => {
    const { repo, wm } = await makeWm();
    await wm.createWorktree(repo, 't3', 'main');
    await expect(wm.mergeBack(repo, 't3', 'main')).resolves.toBeUndefined();
  });

  it('reports a conflict when the task branch conflicts with the base', async () => {
    const { repo, wm } = await makeWm();
    const path = await wm.createWorktree(repo, 't4', 'main');
    await writeFile(join(path, 'README.md'), 'task change\n');
    await git(['add', '.'], path);
    await git(['commit', '-m', 'task change'], path);

    await writeFile(join(repo, 'README.md'), 'base change\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'base change'], repo);

    await expect(wm.mergeBack(repo, 't4', 'main')).rejects.toBeInstanceOf(MergeConflictError);
  });

  it('removes the worktree and its branch', async () => {
    const { repo, wm } = await makeWm();
    await wm.createWorktree(repo, 't5', 'main');
    await wm.removeWorktree(repo, 't5');
    const list = await git(['worktree', 'list'], repo);
    expect(list).not.toContain('fraktole-wts-');
    const branches = await git(['branch', '--list', 'fraktole/t5'], repo);
    expect(branches.trim()).toBe('');
  });
});
