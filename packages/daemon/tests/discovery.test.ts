import { mkdtemp, writeFile } from 'node:fs/promises';
import { chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandExists, discoverDrivers } from '../src/drivers/discovery.js';

async function makeFakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-bin-'));
  await writeFile(join(dir, name), '#!/bin/sh\nexit 0\n');
  await chmod(join(dir, name), 0o755);
  return dir;
}

describe('commandExists', () => {
  it('detects executables on PATH and misses absent ones', async () => {
    const bin = await makeFakeBin('fake-agent-cli');
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      expect(await commandExists('fake-agent-cli')).toBe(true);
      expect(await commandExists('definitely-not-a-cli-xyz')).toBe(false);
    } finally {
      process.env.PATH = old;
    }
  });

  it('requires X_OK (non-executable files do not count)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-bin-'));
    await mkdir(join(dir, 'adir'), { recursive: true });
    await writeFile(join(dir, 'plain-file'), 'not executable');
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      expect(await commandExists('plain-file')).toBe(false);
      expect(await commandExists('adir')).toBe(false);
    } finally {
      process.env.PATH = old;
    }
  });
});

describe('discoverDrivers', () => {
  it('reports installed flags for registered entries', async () => {
    const bin = await makeFakeBin('my-plugin');
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      const drivers = await discoverDrivers([
        { id: 'opencode', command: 'opencode' },
        { id: 'my-plugin', command: 'my-plugin' },
      ]);
      expect(drivers.find((d) => d.id === 'my-plugin')?.installed).toBe(true);
      expect(drivers.find((d) => d.id === 'opencode')?.installed).toBe(
        (await commandExists('opencode')) === true,
      );
    } finally {
      process.env.PATH = old;
    }
  });
});
