import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Settings } from '../src/shared/ipc.js';

/**
 * App preferences, persisted as JSON under userData: the color theme and the
 * reviewer harness model config.
 */
export const DEFAULT_REVIEWER = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-4-5',
};

export class SettingsStore {
  constructor(private readonly file: string) {}

  async get(): Promise<Settings> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        theme: typeof parsed.theme === 'string' ? parsed.theme : 'midnight',
        reviewer: {
          provider:
            parsed.reviewer?.provider === 'openai' ||
            parsed.reviewer?.provider === 'anthropic' ||
            parsed.reviewer?.provider === 'ollama'
              ? parsed.reviewer.provider
              : DEFAULT_REVIEWER.provider,
          model: typeof parsed.reviewer?.model === 'string' ? parsed.reviewer.model : DEFAULT_REVIEWER.model,
          apiKeyEnv: typeof parsed.reviewer?.apiKeyEnv === 'string' ? parsed.reviewer.apiKeyEnv : undefined,
          baseUrl: typeof parsed.reviewer?.baseUrl === 'string' ? parsed.reviewer.baseUrl : undefined,
        },
      };
    } catch {
      return {
        theme: 'midnight',
        reviewer: { provider: DEFAULT_REVIEWER.provider, model: DEFAULT_REVIEWER.model },
      };
    }
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next: Settings = { ...current, ...patch, reviewer: { ...current.reviewer, ...patch.reviewer } };
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, this.file);
    return next;
  }
}
