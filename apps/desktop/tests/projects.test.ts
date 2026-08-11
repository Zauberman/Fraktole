import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProjectsStore } from '../electron/projects.js';

const execFileP = promisify(execFile);

async function makeRepo(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'x\n');
  await execFileP('git', ['add', '-A'], { cwd: dir });
  await execFileP('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('ProjectsStore', () => {
  it('adds a git repo by its toplevel and dedups nested adds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-proj-'));
    const repo = await makeRepo(parent, 'proj');
    const store = new ProjectsStore(join(parent, 'data', 'projects.json'));
    const deep = join(repo, 'src', 'deep');
    await mkdir(deep, { recursive: true });

    const p1 = await store.add(deep);
    expect(p1.path).toBe(repo);
    expect(p1.name).toBe('proj');

    const p2 = await store.add(repo);
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(p2.path).toBe(p1.path);
    await rm(parent, { recursive: true, force: true });
  });

  it('registers plain directories as-is', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-plain-'));
    const plain = join(parent, 'plain');
    await mkdir(plain, { recursive: true });
    const store = new ProjectsStore(join(parent, 'data', 'projects.json'));
    const p = await store.add(plain);
    expect(p.path).toBe(plain);
    expect(p.name).toBe('plain');
    await rm(parent, { recursive: true, force: true });
  });

  it('persists across instances and sorts by recency', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-persist-'));
    const a = await makeRepo(parent, 'aa');
    const b = await makeRepo(parent, 'bb');
    const file = join(parent, 'data', 'projects.json');
    const s1 = new ProjectsStore(file);
    await s1.add(a);
    await s1.add(b);
    // touch b again → most recent
    await s1.add(b);
    const s2 = new ProjectsStore(file);
    const all = await s2.list();
    expect(all.length).toBe(2);
    expect(all[0]!.name).toBe('bb');
    await rm(parent, { recursive: true, force: true });
  });

  it('removes by path and reports false when absent', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-remove-'));
    const repo = await makeRepo(parent, 'rr');
    const file = join(parent, 'data', 'projects.json');
    const store = new ProjectsStore(file);
    await store.add(repo);
    const sub = join(repo, 'sub');
    await mkdir(sub, { recursive: true });
    expect(await store.remove(sub)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.remove(repo)).toBe(false);
    await rm(parent, { recursive: true, force: true });
  });

  it('binds a session to a project and preserves it across adds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-bind-'));
    const repo = await makeRepo(parent, 'bind');
    const file = join(parent, 'data', 'projects.json');
    const store = new ProjectsStore(file);
    await store.add(repo);
    const bound = await store.bindSession(repo, 's-abc');
    expect(bound?.sessionId).toBe('s-abc');
    // add() keeps the binding (recency touch only)
    await store.add(repo);
    const all = await store.list();
    expect(all[0]?.sessionId).toBe('s-abc');
    await rm(parent, { recursive: true, force: true });
  });

  it('bindSession is a no-op for unknown projects', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frakt-bind2-'));
    const file = join(parent, 'data', 'projects.json');
    const store = new ProjectsStore(file);
    expect(await store.bindSession(join(parent, 'ghost'), 's-x')).toBeNull();
    await rm(parent, { recursive: true, force: true });
  });
});
