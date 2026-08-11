import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Settings } from '../src/shared/ipc.js';

/**
 * App preferences, persisted as JSON under userData. Today: the color theme
 * and the CLI command that runs as the orchestrator judge.
 */
export const DEFAULT_JUDGE_COMMAND = 'opencode';

export class SettingsStore {
  constructor(private readonly file: string) {}

  async get(): Promise<Settings> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        theme: typeof parsed.theme === 'string' ? parsed.theme : 'midnight',
        judgeCommand: typeof parsed.judgeCommand === 'string' ? parsed.judgeCommand : DEFAULT_JUDGE_COMMAND,
      };
    } catch {
      return { theme: 'midnight', judgeCommand: DEFAULT_JUDGE_COMMAND };
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
