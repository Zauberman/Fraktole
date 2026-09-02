import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog } from '../electron/usage-log.js';

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function sample(at: number): { at: number; inputTokens: number; cachedTokens: number; outputTokens: number } {
  return { at, inputTokens: at + 1, cachedTokens: 3, outputTokens: 2 };
}

async function newLog(): Promise<{ log: UsageLog; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'frak-usage-'));
  dirs.push(dir);
  return { log: new UsageLog(dir), file: join(dir, 'usage.jsonl') };
}

describe('UsageLog', () => {
  it('round-trips appended samples', async () => {
    const { log } = await newLog();
    await log.append(sample(1));
    await log.append(sample(2));
    expect(await log.read()).toEqual([sample(1), sample(2)]);
  });

  it('reads [] when the file is missing or empty', async () => {
    const { log } = await newLog();
    expect(await log.read()).toEqual([]);
  });

  it('skips corrupt and malformed lines', async () => {
    const { log, file } = await newLog();
    await log.append(sample(1));
    await appendFile(file, ['{broken', JSON.stringify({ at: 2, nope: true }), ''].join('\n'), 'utf8');
    await log.append(sample(3));
    expect(await log.read()).toEqual([sample(1), sample(3)]);
  });

  it('trims past 5000 lines to the newest 4000 (lazy count from disk)', async () => {
    const { log, file } = await newLog();
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(JSON.stringify(sample(i)));
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    await log.append(sample(5000));
    let all = await log.read();
    expect(all.length).toBe(4000);
    expect(all[0]!.at).toBe(1001);
    expect(all[all.length - 1]!.at).toBe(5000);
    // the in-memory count keeps tracking after a trim: 1000 more appends
    // stay under the cap, the next one trims again
    for (let i = 5001; i <= 6000; i++) await log.append(sample(i));
    all = await log.read();
    expect(all.length).toBe(5000);
    await log.append(sample(6001));
    all = await log.read();
    expect(all.length).toBe(4000);
    expect(all[all.length - 1]!.at).toBe(6001);
  });
});
