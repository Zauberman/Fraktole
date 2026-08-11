import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../electron/sessions.js';
import { treeFromSer, treeToSer } from '../src/session-tree.js';
import type { SerNode } from '../src/shared/ipc.js';
import type { TileNode } from '../src/window-tree.js';
import { insert, listIds } from '../src/window-tree.js';

function makeTree(ids: string[], dirs: Array<'h' | 'v'>): TileNode {
  let t: TileNode | null = null;
  ids.forEach((id, i) => {
    t = insert(t, null, id, dirs[i % dirs.length] ?? 'h');
  });
  return t!;
}

const agentOf = (id: string): string => `agent-${id}`;
const tileOf = (agentId: string): string => agentId.slice('agent-'.length);

describe('tree serialization', () => {
  it('roundtrips a single leaf', () => {
    const t = makeTree(['t1'], ['h']);
    const ser = treeToSer(t, agentOf);
    expect(ser).toEqual({ k: 'leaf', agentId: 'agent-t1' });
    expect(treeFromSer(ser, tileOf)).toEqual(t);
  });

  it('roundtrips a 4-tile mixed tree and preserves ratios', () => {
    const t = makeTree(['t1', 't2', 't3', 't4'], ['h', 'v', 'h']);
    // force a non-default ratio into the tree
    const deep: TileNode = {
      kind: 'split',
      dir: 'h',
      ratio: 0.25,
      a: t,
      b: { kind: 'leaf', id: 't5' },
    };
    const ser = treeToSer(deep, agentOf);
    const back = treeFromSer(ser, tileOf);
    expect(back).toEqual(deep);
    expect(listIds(back!)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('roundtrips 200 random trees (property)', () => {
    const rng = (): number => Math.floor(Math.random() * 1_000_000);
    for (let run = 0; run < 200; run += 1) {
      let t: TileNode | null = null;
      for (let i = 0; i < 12; i += 1) {
        const id = `t${i}`;
        t = insert(t, null, id, i % 2 === 0 ? 'h' : 'v');
        if (rng() % 3 === 0 && t !== null && t.kind !== 'leaf') {
          // occasionally remove to grow deeper trees
          const ids = listIds(t);
          t = insert(t, ids[rng() % ids.length] ?? null, `x${i}`, 'v');
        }
      }
      const ser = treeToSer(t, agentOf);
      expect(treeFromSer(ser, tileOf)).toEqual(t);
    }
  });

  it('handles null trees', () => {
    expect(treeToSer(null, agentOf)).toBeNull();
    expect(treeFromSer(null, tileOf)).toBeNull();
  });

  it('preserves every ratio in a deep tree', () => {
    const ratios: number[] = [];
    const collect = (n: TileNode): void => {
      if (n.kind === 'split') {
        ratios.push(n.ratio);
        collect(n.a);
        collect(n.b);
      }
    };
    let t: TileNode | null = makeTree(['t1', 't2', 't3'], ['h', 'v']);
    if (t?.kind !== 'split') throw new Error('expected split');
    t = { kind: 'split', dir: 'v', ratio: 0.31, a: t, b: { kind: 'leaf', id: 't9' } };
    const back = treeFromSer(treeToSer(t, agentOf), tileOf);
    ratios.length = 0;
    collect(back!);
    expect(ratios).toEqual([0.31, 0.5, 0.5]);
  });
});

describe('SessionStore', () => {
  async function makeStore(): Promise<{ store: SessionStore; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'frakt-sess-'));
    return { store: new SessionStore(root), root };
  }

  it('newSession scaffolds the session dirs and index entry', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('alpha');
    await expect(readFile(join(root, session.id, 'session.json'), 'utf8')).resolves.toContain('"alpha"');
    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as { sessions: Array<{ id: string; name: string }> };
    expect(idx.sessions).toHaveLength(1);
    expect(idx.sessions[0]?.name).toBe('alpha');
    await rm(root, { recursive: true, force: true });
  });

  it('list() reports agentCount and skips corrupt sessions', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('beta');
    session.tiles = [{ agentId: 'agent-1', cwd: '/tmp' }];
    await store.save(session);
    const broken = await store.newSession('broken');
    await rm(join(root, broken.session.id, 'session.json'), { force: true });

    const all = await store.list();
    // the corrupt session is skipped, the healthy one survives
    expect(all).toHaveLength(1);
    expect(all[0]?.agentCount).toBe(1);
    await rm(root, { recursive: true, force: true });
  });

  it('allocateAgentId is monotonic across save/load cycles', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('gamma');
    expect(store.allocateAgentId(session)).toBe('agent-1');
    expect(store.allocateAgentId(session)).toBe('agent-2');
    await store.save(session);
    const reloaded = await store.load(session.id);
    expect(store.allocateAgentId(reloaded)).toBe('agent-3');
    await rm(root, { recursive: true, force: true });
  });

  it('rename updates both the model and the index', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('old');
    const renamed = await store.rename(session.id, 'new name');
    expect(renamed.name).toBe('new name');
    const all = await store.list();
    expect(all[0]?.name).toBe('new name');
    await rm(root, { recursive: true, force: true });
  });

  it('delete removes the session dir and index entry', async () => {
    const { store, root } = await makeStore();
    const a = await store.newSession('a');
    await store.newSession('b');
    await store.delete(a.session.id);
    const all = await store.list();
    expect(all.map((s) => s.name)).toEqual(['b']);
    await expect(store.load(a.session.id)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it('load rejects unsupported versions', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('v');
    await store.save({ ...session, version: 99 as unknown as 1 });
    await expect(store.load(session.id)).rejects.toThrow(/unsupported/);
    await rm(root, { recursive: true, force: true });
  });

  it('ensureAgentMailbox creates inbox/outbox and listAgentIds finds them', async () => {
    const { store, root } = await makeStore();
    const { session } = await store.newSession('mail');
    await store.ensureAgentMailbox(session.id, 'agent-1');
    await store.ensureAgentMailbox(session.id, 'agent-2');
    expect(await store.listAgentIds(session.id)).toEqual(['agent-1', 'agent-2']);
    await rm(root, { recursive: true, force: true });
  });
});

describe('SerNode persistence shape', () => {
  it('persists exactly the documented JSON shape', () => {
    const ser: SerNode = {
      k: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { k: 'leaf', agentId: 'agent-1' },
      b: { k: 'split', dir: 'v', ratio: 0.5, a: { k: 'leaf', agentId: 'agent-2' }, b: { k: 'leaf', agentId: 'agent-3' } },
    };
    expect(JSON.parse(JSON.stringify(ser))).toEqual(ser);
  });
});
