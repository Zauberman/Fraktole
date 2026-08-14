import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkProject } from '../electron/fork.js';

async function gitInit(dir: string, file: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, 'utf8');
  await execFile('git', ['init', '-q', dir]);
  await execFile('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 't']);
  await execFile('git', ['-C', dir, 'add', '.']);
  await execFile('git', ['-C', dir, 'commit', '-qm', 'init']);
}

describe('forkProject', () => {
  it('clones a clean git repo into the destination (history included)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-fork-'));
    const src = join(root, 'src');
    const dest = join(root, 'fork');
    await gitInit(src, 'a.txt', 'hello');
    const res = await forkProject(src, dest, join(root, 'home'));
    expect(res.ok).toBe(true);
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('hello');
    await expect(stat(join(dest, '.git'))).resolves.toBeTruthy();
    await rm(root, { recursive: true, force: true });
  });

  it('copies a non-git project and skips heavy directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-fork-'));
    const src = join(root, 'src');
    await mkdir(join(src, 'node_modules'), { recursive: true });
    await mkdir(join(src, 'lib'), { recursive: true });
    await writeFile(join(src, 'package.json'), '{"name":"x"}', 'utf8');
    await writeFile(join(src, 'node_modules', 'dep.js'), 'x', 'utf8');
    await writeFile(join(src, 'lib', 'main.ts'), 'export const a = 1;', 'utf8');
    const res = await forkProject(src, join(root, 'fork'), join(root, 'home'));
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, 'fork', 'lib', 'main.ts'), 'utf8')).toContain('a = 1');
    await expect(stat(join(root, 'fork', 'node_modules'))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('copies a DIRTY git worktree (uncommitted work included)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-fork-'));
    const src = join(root, 'src');
    await gitInit(src, 'a.txt', 'committed');
    await writeFile(join(src, 'dirty.txt'), 'uncommitted', 'utf8');
    const res = await forkProject(src, join(root, 'fork'), join(root, 'home'));
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, 'fork', 'dirty.txt'), 'utf8')).toBe('uncommitted');
    await rm(root, { recursive: true, force: true });
  });

  it('resets an existing destination before forking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-fork-'));
    const src = join(root, 'src');
    const dest = join(root, 'fork');
    await gitInit(src, 'a.txt', 'v1');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'stale.txt'), 'stale', 'utf8');
    const res = await forkProject(src, dest, join(root, 'home'));
    expect(res.ok).toBe(true);
    await expect(stat(join(dest, 'stale.txt'))).rejects.toThrow();
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('v1');
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to fork the home directory and missing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-fork-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const res = await forkProject(home, join(root, 'fork'), home);
    expect(res).toEqual({ ok: false, error: 'no project to fork (cwd is the home directory)' });
    const missing = await forkProject(join(root, 'nope'), join(root, 'fork2'), home);
    expect(missing).toEqual({ ok: false, error: 'project directory not found' });
    await rm(root, { recursive: true, force: true });
  });
});
