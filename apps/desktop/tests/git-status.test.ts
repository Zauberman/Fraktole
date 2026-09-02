import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectGitStatus, parsePorcelain } from '../electron/git-status.js';

const execFileP = promisify(execFile);

describe('parsePorcelain', () => {
  it('reads the branch with an upstream and ahead/behind suffix', () => {
    const out = '## main...origin/main [ahead 1, behind 2]\n M a.ts\n';
    expect(parsePorcelain(out)).toEqual({
      branch: 'main',
      entries: { 'a.ts': 'M' },
    });
  });

  it('reads a branch without an upstream', () => {
    expect(parsePorcelain('## feature/x\n').branch).toBe('feature/x');
  });

  it('maps staged, unstaged, deleted and untracked marks', () => {
    const out = ['A  added.ts', 'M  staged.md', ' M unstaged.md', 'D  gone.js', '?? scratch.log', ''].join('\n');
    expect(parsePorcelain(out).entries).toEqual({
      'added.ts': 'A',
      'staged.md': 'M',
      'unstaged.md': 'M',
      'gone.js': 'D',
      'scratch.log': '?',
    });
  });

  it('maps a rename row to the NEW path', () => {
    const out = 'R  old-name.ts -> new-name.ts\n';
    const { entries } = parsePorcelain(out);
    expect(entries['new-name.ts']).toBe('R');
    expect(entries['old-name.ts']).toBeUndefined();
  });

  it('unquotes core.quotePath octal escapes as UTF-8', () => {
    // "caf\303\251.md" → café.md
    const out = '?? "caf\\303\\251.md"\n';
    expect(parsePorcelain(out).entries['café.md']).toBe('?');
  });

  it('skips rows with unsupported marks or undecodable quoting', () => {
    const out = ['C  copied.ts', 'U  merged.txt', ' M "bad\\qpath.md"', ''].join('\n');
    expect(parsePorcelain(out).entries).toEqual({});
  });

  it('reports null for a detached HEAD and for an unborn branch header', () => {
    expect(parsePorcelain('## HEAD (no branch)\n').branch).toBeNull();
    expect(parsePorcelain('## No commits yet on main\n').branch).toBe('main');
  });
});

describe('collectGitStatus', () => {
  it('collects branch and marks from a real repo', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-git-'));
    const repo = join(parent, 'proj');
    await mkdir(repo);
    await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'one\n');
    await execFileP('git', ['add', '-A'], { cwd: repo });
    await execFileP('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'two\n');
    await writeFile(join(repo, 'untracked.txt'), 'x\n');

    const status = await collectGitStatus(repo);
    expect(status).not.toBeNull();
    expect(status!.branch).toBe('main');
    expect(status!.entries['tracked.txt']).toBe('M');
    expect(status!.entries['untracked.txt']).toBe('?');
    await rm(parent, { recursive: true, force: true });
  });

  it('returns null outside a repo and for a missing path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-norepo-'));
    expect(await collectGitStatus(parent)).toBeNull();
    expect(await collectGitStatus(join(parent, 'missing'))).toBeNull();
    await rm(parent, { recursive: true, force: true });
  });
});
