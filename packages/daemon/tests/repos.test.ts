import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { defaults, loadConfig, type FraktoleConfig } from '@fraktole/core';
import { RepoRegistry } from '../src/repos.js';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fraktole-repos-repo-'));
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await writeFile(join(repo, 'f.txt'), 'x\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'init'], repo);
  return repo;
}

async function makeRegistry() {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-repos-'));
  const configPath = join(dir, 'config.json');
  const config: FraktoleConfig = { ...defaults(), dataDir: join(dir, 'data') };
  await writeFile(configPath, JSON.stringify(config));
  const registry = new RepoRegistry(configPath, config);
  return { configPath, config, registry, dir };
}

describe('RepoRegistry', () => {
  it('resolves nested paths to the toplevel and persists additions', async () => {
    const repo = await makeRepo();
    const subdir = join(repo, 'src');
    await mkdir(subdir);
    const { configPath, registry } = await makeRegistry();

    const added = await registry.add(subdir); // nested path
    expect(added.path).toBe(repo);

    const reloaded = await loadConfig(configPath);
    expect(reloaded.repos.some((r) => r.path === repo)).toBe(true);
  });

  it('dedupes repeated additions', async () => {
    const repo = await makeRepo();
    const { registry } = await makeRegistry();

    await registry.add(repo);
    await registry.add(repo);
    expect(registry.list()).toHaveLength(1);
  });

  it('accepts plain directories (no git required)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-plain-'));
    const { registry } = await makeRegistry();
    const added = await registry.add(dir);
    expect(added.path).toBe(dir);
    expect(registry.list()).toHaveLength(1);
  });

  it('removes registered repos', async () => {
    const repo = await makeRepo();
    const { configPath, registry } = await makeRegistry();
    await registry.add(repo);
    expect(await registry.remove(repo)).toBe(true);
    expect(await registry.remove(repo)).toBe(false);
    const reloaded = await loadConfig(configPath);
    expect(reloaded.repos).toHaveLength(0);
  });

  it('persisted config remains valid for loadConfig', async () => {
    const repo = await makeRepo();
    const { configPath, registry } = await makeRegistry();
    await registry.add(repo);
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    expect(raw.repos[0].path).toBe(repo);
  });
});
