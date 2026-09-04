import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../electron/settings.js';

let dirs: string[] = [];

async function storeWith(raw: Record<string, unknown>): Promise<SettingsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'frak-settings-'));
  const file = join(dir, 'settings.json');
  dirs.push(dir);
  await writeFile(file, JSON.stringify(raw), 'utf8');
  return new SettingsStore(file);
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe('SettingsStore knobs whitelist', () => {
  it('keeps every valid knob and drops invalid values individually', async () => {
    const s = await storeWith({
      theme: 'midnight',
      reviewer: {
        apiKey: 'sk-x',
        knobs: {
          contextTokens: 65536,
          maxOutputTokens: 2048,
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          minP: 0.05,
          seed: 42,
          repeatPenalty: 1.1,
          presencePenalty: 0.5,
          frequencyPenalty: -0.5,
          keepAlive: '5m',
          think: false,
        },
      },
    });
    const { reviewer } = await s.get();
    expect(reviewer.knobs).toEqual({
      contextTokens: 65536,
      maxOutputTokens: 2048,
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      minP: 0.05,
      seed: 42,
      repeatPenalty: 1.1,
      presencePenalty: 0.5,
      frequencyPenalty: -0.5,
      keepAlive: '5m',
      think: false,
      thinkingMode: 'off', // legacy boolean `think` migrates one-way
    });
  });

  it('drops out-of-range values instead of persisting them', async () => {
    const s = await storeWith({
      reviewer: {
        knobs: {
          contextTokens: 100, // below 1024
          maxOutputTokens: 10, // below 256
          temperature: 3, // above 2
          topP: 1.5,
          topK: -1, // below 0
          minP: -0.1,
          seed: -2, // below -1
          repeatPenalty: 2.5,
          presencePenalty: 3,
          frequencyPenalty: -2.25,
        },
      },
    });
    const { reviewer } = await s.get();
    expect(reviewer.knobs).toBeUndefined();
  });

  it('drops non-numeric and non-boolean values without touching the rest', async () => {
    const s = await storeWith({
      reviewer: {
        knobs: {
          contextTokens: 'lots',
          temperature: 'hot',
          keepAlive: '5x',
          think: 'yes',
          seed: 7,
        },
      },
    });
    const { reviewer } = await s.get();
    expect(reviewer.knobs).toEqual({ seed: 7 });
  });

  it('accepts keep_alive "0" and a string duration', async () => {
    const s = await storeWith({
      reviewer: {
        knobs: { keepAlive: '0', contextTokens: 1024 },
      },
    });
    const { reviewer } = await s.get();
    expect(reviewer.knobs).toEqual({ keepAlive: '0', contextTokens: 1024 });
  });

  it('yields undefined knobs when absent or fully invalid', async () => {
    const s1 = await storeWith({ reviewer: { apiKey: 'k' } });
    expect((await s1.get()).reviewer.knobs).toBeUndefined();
    const s2 = await storeWith({ reviewer: { knobs: { think: 'true', contextTokens: 9999999999 } } });
    expect((await s2.get()).reviewer.knobs).toBeUndefined();
  });

  it('round-trips a patch that carries knobs (settings.set)', async () => {
    const s = await storeWith({ reviewer: { apiKey: 'old' } });
    await s.set({ reviewer: { knobs: { temperature: 0.3, contextTokens: 32768 } } });
    const { reviewer } = await s.get();
    expect(reviewer.knobs).toEqual({ temperature: 0.3, contextTokens: 32768 });
    expect(reviewer.apiKey).toBe('old'); // patch merges, never wipes
  });

  it('validates pollSeconds (2–600, integers only, dropped otherwise)', async () => {
    const ok = await storeWith({ reviewer: { pollSeconds: 90 } });
    expect((await ok.get()).reviewer.pollSeconds).toBe(90);
    for (const bad of [1, 601, 15.5, 'fast', true, -3]) {
      const s = await storeWith({ reviewer: { pollSeconds: bad } });
      expect((await s.get()).reviewer.pollSeconds).toBeUndefined();
    }
  });

  it('validates thinkingMode and thinkingBudgetTokens, migrates legacy think', async () => {
    const on = await storeWith({ reviewer: { knobs: { thinkingMode: 'on', thinkingBudgetTokens: 8192 } } });
    expect((await on.get()).reviewer.knobs).toEqual({ thinkingMode: 'on', thinkingBudgetTokens: 8192 });
    // legacy boolean migrate: true → on, false → off
    const legacy = await storeWith({ reviewer: { knobs: { think: true } } });
    expect((await legacy.get()).reviewer.knobs).toEqual({ think: true, thinkingMode: 'on' });
    // an explicit thinkingMode wins over the legacy boolean
    const both = await storeWith({ reviewer: { knobs: { think: false, thinkingMode: 'on' } } });
    expect((await both.get()).reviewer.knobs).toEqual({ think: false, thinkingMode: 'on' });
    // out-of-range budget and junk modes drop individually
    const junk = await storeWith({ reviewer: { knobs: { thinkingMode: 'maybe', thinkingBudgetTokens: 512, temperature: 0.4 } } });
    expect((await junk.get()).reviewer.knobs).toEqual({ temperature: 0.4 });
    const big = await storeWith({ reviewer: { knobs: { thinkingBudgetTokens: 40000 } } });
    expect((await big.get()).reviewer.knobs).toBeUndefined();
  });
});
