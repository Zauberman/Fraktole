import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageSample } from '../src/shared/ipc.js';

/** Rolling per-turn token-usage log over <dir>/usage.jsonl: one JSON line
 *  per sample. Past 5000 lines the file is rewritten in place down to the
 *  newest 4000; the line count is tracked in memory from one lazy read so
 *  the cap check never rescans the file. Corrupt lines are skipped on read
 *  — same policy as the conversation loader. */

const MAX_LINES = 5000;
const KEEP_LINES = 4000;

export class UsageLog {
  private count: number | null = null;

  constructor(private readonly dir: string) {}

  async append(sample: UsageSample): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify(sample)}\n`, 'utf8');
    this.count = (this.count ?? (await this.lineCount())) + 1;
    if (this.count > MAX_LINES) await this.trim();
  }

  async read(): Promise<UsageSample[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: UsageSample[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isSample(parsed)) out.push(parsed);
      } catch {
        // a corrupt line must not hide the rest
      }
    }
    return out;
  }

  private get file(): string {
    return join(this.dir, 'usage.jsonl');
  }

  private async lineCount(): Promise<number> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw.split('\n').filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  private async trim(): Promise<void> {
    const kept = (await this.read()).slice(-KEEP_LINES);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, kept.length > 0 ? `${kept.map((s) => JSON.stringify(s)).join('\n')}\n` : '', 'utf8');
    await rename(tmp, this.file);
    this.count = kept.length;
  }
}

function isSample(v: unknown): v is UsageSample {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<UsageSample>;
  return (
    typeof s.at === 'number' &&
    Number.isFinite(s.at) &&
    typeof s.inputTokens === 'number' &&
    Number.isFinite(s.inputTokens) &&
    typeof s.cachedTokens === 'number' &&
    Number.isFinite(s.cachedTokens) &&
    typeof s.outputTokens === 'number' &&
    Number.isFinite(s.outputTokens)
  );
}
