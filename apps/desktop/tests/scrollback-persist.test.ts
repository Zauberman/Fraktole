import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrollbackPersist } from '../electron/scrollback-persist.js';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fraktole-persist-'));
}

const lineMap = new Map<string, string[]>();
const agentOf = (tileId: string): string | null =>
  tileId === 'tile-1' ? 'agent-1' : tileId === 'tile-2' ? 'agent-2' : null;

function makePersist(dir: string, opts: Partial<{ debounceMs: number }> = {}): ScrollbackPersist {
  return new ScrollbackPersist({
    sessionDir: dir,
    agentOfTile: agentOf,
    linesOf: (tileId) => lineMap.get(tileId) ?? [],
    debounceMs: opts.debounceMs ?? 30,
    logger: () => undefined,
  });
}

async function readFileLines(dir: string, agentId: string): Promise<string[] | null> {
  try {
    const raw = await readFile(join(dir, 'scrollback', `${agentId}.json`), 'utf8');
    return (JSON.parse(raw) as { lines: string[] }).lines;
  } catch {
    return null;
  }
}

describe('ScrollbackPersist', () => {
  let dir: string;
  beforeEach(async () => {
    lineMap.clear();
    dir = await makeDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a debounced file for a tile that produced output', async () => {
    lineMap.set('tile-1', ['a', 'b', 'c']);
    const persist = makePersist(dir);
    persist.note('tile-1');
    expect(await readFileLines(dir, 'agent-1')).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    const lines = await readFileLines(dir, 'agent-1');
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('skips tiles with no agent mapping', async () => {
    const persist = makePersist(dir);
    persist.note('ghost-tile');
    await new Promise((r) => setTimeout(r, 60));
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('skips a no-op debounce (same content is not rewritten)', async () => {
    lineMap.set('tile-1', ['x']);
    const persist = makePersist(dir);
    persist.note('tile-1');
    await new Promise((r) => setTimeout(r, 60));
    const first = await readFileLines(dir, 'agent-1');
    expect(first).toEqual(['x']);
    // second note with identical content → no rewrite (mtime unchanged)
    const file = join(dir, 'scrollback', 'agent-1.json');
    const stat = await import('node:fs/promises');
    const mtime1 = (await stat.stat(file)).mtimeMs;
    persist.note('tile-1');
    await new Promise((r) => setTimeout(r, 60));
    const mtime2 = (await stat.stat(file)).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('flushTile writes immediately on tile exit, even before the debounce', async () => {
    lineMap.set('tile-1', ['final-1', 'final-2']);
    const persist = makePersist(dir, { debounceMs: 10_000 });
    await persist.flushTile('tile-1', ['final-1', 'final-2']);
    expect(await readFileLines(dir, 'agent-1')).toEqual(['final-1', 'final-2']);
  });

  it('flushTile never creates a file for a tile that produced nothing', async () => {
    const persist = makePersist(dir);
    await persist.flushTile('tile-2', []);
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('flushTile cancels a pending debounced write so it does not double-write', async () => {
    lineMap.set('tile-1', ['a']);
    const persist = makePersist(dir);
    persist.note('tile-1');
    await persist.flushTile('tile-1', ['a']);
    expect(await readFileLines(dir, 'agent-1')).toEqual(['a']);
    // let the (now-cancelled) debounce window pass — file must be unchanged
    await new Promise((r) => setTimeout(r, 60));
    expect(await readFileLines(dir, 'agent-1')).toEqual(['a']);
  });

  it('caps persisted lines to maxLines', async () => {
    lineMap.set('tile-1', Array.from({ length: 20 }, (_, i) => `l${i}`));
    const persist = new ScrollbackPersist({
      sessionDir: dir,
      agentOfTile: agentOf,
      linesOf: (tileId) => lineMap.get(tileId) ?? [],
      debounceMs: 30,
      maxLines: 5,
      logger: () => undefined,
    });
    persist.note('tile-1');
    await new Promise((r) => setTimeout(r, 60));
    const lines = await readFileLines(dir, 'agent-1');
    expect(lines).toEqual(['l15', 'l16', 'l17', 'l18', 'l19']);
  });

  it('dispose cancels pending timers', async () => {
    lineMap.set('tile-1', ['a']);
    const persist = makePersist(dir);
    persist.note('tile-1');
    persist.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(await readFileLines(dir, 'agent-1')).toBeNull();
  });

  it('does not leave a tmp file behind', async () => {
    lineMap.set('tile-1', ['a']);
    const persist = makePersist(dir);
    persist.note('tile-1');
    // wait for the flush to LAND instead of a fixed sleep — a loaded
    // machine can stretch the debounced write past any fixed window
    const deadline = Date.now() + 5000;
    let entries: string[] = [];
    for (;;) {
      try {
        entries = await readdir(join(dir, 'scrollback'));
      } catch {
        // the flush has not created the directory yet — keep polling
        entries = [];
      }
      if (entries.includes('agent-1.json')) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(entries).toEqual(['agent-1.json']);
  });
});
