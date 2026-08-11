import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaults, ensureConfig, loadConfig } from '../src/config.js';

async function withConfig(obj: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-config-'));
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify(obj));
  return file;
}

describe('loadConfig', () => {
  it('merges a partial config over defaults', async () => {
    const file = await withConfig({ server: { port: 9999 }, dataDir: '/tmp/custom-data' });
    const cfg = await loadConfig(file);
    expect(cfg.server.port).toBe(9999);
    expect(cfg.dataDir).toBe('/tmp/custom-data');
    expect(cfg.server.host).toBe(defaults().server.host);
    expect(cfg.gates.mergeToMain).toBe(true);
    expect(cfg.limits.maxConcurrent).toBe(2);
  });

  it('throws ConfigError naming the field path on a wrong type', async () => {
    const file = await withConfig({ planner: { model: 42 } });
    await expect(loadConfig(file)).rejects.toMatchObject({
      name: 'ConfigError',
      message: /planner\.model/,
    });
  });

  it('throws ConfigError for invalid repos entries', async () => {
    const file = await withConfig({ repos: [{ path: 5 }] });
    await expect(loadConfig(file)).rejects.toThrow(/repos\[0\]\.path/);
  });

  it('throws ConfigError for invalid plugin entries', async () => {
    const file = await withConfig({ agents: { plugins: [{ id: 'p', command: 'x' }] } });
    await expect(loadConfig(file)).rejects.toThrow(/agents\.plugins\[0\]\.args/);
  });

  it('loads with or without server.tls', async () => {
    const noTls = await withConfig({});
    expect((await loadConfig(noTls)).server.tls).toBeUndefined();

    const withTls = await withConfig({ server: { tls: { cert: 'c.pem', key: 'k.pem' } } });
    expect((await loadConfig(withTls)).server.tls).toEqual({ cert: 'c.pem', key: 'k.pem' });
  });

  it('throws ConfigError on a missing file and on a non-object root', async () => {
    await expect(loadConfig('/nonexistent/fraktole.json')).rejects.toThrow(ConfigError);
    const bad = await withConfig([1, 2, 3]);
    await expect(loadConfig(bad)).rejects.toThrow(/must be a JSON object/);
  });

  it('rejects an unknown planner provider', async () => {
    const file = await withConfig({ planner: { provider: 'deepseek' } });
    await expect(loadConfig(file)).rejects.toThrow(/planner\.provider/);
  });
});

describe('ensureConfig', () => {
  it('writes a default config with a random token on first run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-ensure-'));
    const file = join(dir, 'config.json');
    const cfg = await ensureConfig(file);

    expect(cfg.server.tokens).toHaveLength(1);
    expect(cfg.server.tokens[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(cfg.planner.decompose).toBe(true);

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { server: { tokens: string[] } };
    expect(onDisk.server.tokens).toEqual(cfg.server.tokens);
  });

  it('never touches an existing config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-ensure-'));
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ server: { port: 9999 } }));
    const cfg = await ensureConfig(file);
    expect(cfg.server.port).toBe(9999);
    expect(cfg.server.tokens).toHaveLength(0); // untouched default
  });

  it('is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-ensure-'));
    const file = join(dir, 'config.json');
    const first = await ensureConfig(file);
    const second = await ensureConfig(file);
    expect(second.server.tokens).toEqual(first.server.tokens);
  });
});
