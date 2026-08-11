import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDaemon } from '../src/index.js';

describe('runDaemon', () => {
  it('writes a snapshot after every 200 published events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-daemon-'));
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ dataDir: join(dir, 'data'), server: { tokens: ['t'] } }),
    );

    const daemon = await runDaemon(configPath);
    for (let i = 0; i < 200; i++) {
      daemon.bus.publish('TaskQueued', `t-${i}`, { taskId: `t-${i}` });
    }
    await daemon.persist.flush();

    const snapshot = await readFile(join(daemon.config.dataDir, 'snapshot.json'), 'utf8');
    expect(JSON.parse(snapshot)).toMatchObject({ version: 1, tasks: {} });
  });
});
