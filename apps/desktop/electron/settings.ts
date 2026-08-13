import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Settings } from '../src/shared/ipc.js';

/**
 * App preferences, persisted as JSON under userData: the color theme and the
 * reviewer harness config. The reviewer derives provider/endpoint from the
 * pasted API key (src/shared/reviewer-detect.ts); explicit overrides are
 * optional and only used for ambiguous sk- keys.
 */
export class SettingsStore {
  constructor(private readonly file: string) {}

  async get(): Promise<Settings> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const provider = parsed.reviewer?.provider;
      return {
        theme: typeof parsed.theme === 'string' ? parsed.theme : 'midnight',
        reviewer: {
          apiKey: typeof parsed.reviewer?.apiKey === 'string' ? parsed.reviewer.apiKey : undefined,
          apiKeyEnv: typeof parsed.reviewer?.apiKeyEnv === 'string' ? parsed.reviewer.apiKeyEnv : undefined,
          provider:
            provider === 'openai' || provider === 'anthropic' || provider === 'ollama' || provider === 'deepseek'
              ? provider
              : undefined,
          model: typeof parsed.reviewer?.model === 'string' ? parsed.reviewer.model : undefined,
          baseUrl: typeof parsed.reviewer?.baseUrl === 'string' ? parsed.reviewer.baseUrl : undefined,
          agentCommand: typeof parsed.reviewer?.agentCommand === 'string' ? parsed.reviewer.agentCommand : undefined,
          reasoningEffort:
            parsed.reviewer?.reasoningEffort === 'low' ||
            parsed.reviewer?.reasoningEffort === 'medium' ||
            parsed.reviewer?.reasoningEffort === 'high'
              ? parsed.reviewer.reasoningEffort
              : undefined,
        },
      };
    } catch {
      return { theme: 'midnight', reviewer: {} };
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
