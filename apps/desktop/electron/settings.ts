import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Settings } from '../src/shared/ipc.js';

/**
 * App preferences, persisted as JSON under userData. The only setting today
 * is the color theme.
 */
export class SettingsStore {
  constructor(private readonly file: string) {}

  async get(): Promise<Settings> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { theme: typeof parsed.theme === 'string' ? parsed.theme : 'midnight' };
    } catch {
      return { theme: 'midnight' };
    }
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next: Settings = { ...current, ...patch };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, this.file);
    return next;
  }
}
