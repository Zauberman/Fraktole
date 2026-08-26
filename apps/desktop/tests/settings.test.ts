import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../electron/settings.js';

describe('SettingsStore', () => {
  it('round-trips reviewer.customAutonomy through get/set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'));
    await store.set({ reviewer: { customAutonomy: { name: 'My Loop', prompt: 'DIRECTIVE' } } });
    expect((await store.get()).reviewer.customAutonomy).toEqual({ name: 'My Loop', prompt: 'DIRECTIVE' });
    // an unrelated later set must not drop the field (get() rebuilds the
    // reviewer object field-by-field)
    await store.set({ theme: 'ocean' });
    expect((await store.get()).reviewer.customAutonomy).toEqual({ name: 'My Loop', prompt: 'DIRECTIVE' });
  });

  it('round-trips reviewer.allowedLaunchers and sanitizes junk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frak-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'));
    await store.set({ reviewer: { allowedLaunchers: [' cursor ', 'goose'] } });
    expect((await store.get()).reviewer.allowedLaunchers).toEqual(['cursor', 'goose']);
    await store.set({ theme: 'ocean' });
    expect((await store.get()).reviewer.allowedLaunchers).toEqual(['cursor', 'goose']);
  });
});
