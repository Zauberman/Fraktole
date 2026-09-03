import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../electron/sessions.js';

let root = '';

beforeEach(async () => {
  root = join(tmpdir(), `fraktole-idx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('session index resilience', () => {
  it('a corrupt index is quarantined and rebuilt from the session dirs', async () => {
    const store = new SessionStore(root);
    const { session: a } = await store.newSession('alpha');
    const { session: b } = await store.newSession('beta');
    await writeFile(join(root, 'index.json'), '{ this is not json', 'utf8');

    const list = await store.list();
    expect(list.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    // the bad file is kept for forensics, not destroyed
    expect((await readdir(root)).some((f) => f.startsWith('index.json.bad-'))).toBe(true);
    // and the rebuilt index is healthy for the next read
    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as { sessions: unknown[] };
    expect(idx.sessions).toHaveLength(2);
  });

  it('a malformed-shape index is rebuilt, not wiped', async () => {
    const store = new SessionStore(root);
    const { session } = await store.newSession('solo');
    await writeFile(join(root, 'index.json'), JSON.stringify({ sessions: 'nope' }), 'utf8');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(session.id);
  });

  it('a missing index stays missing (fresh install)', async () => {
    const store = new SessionStore(root);
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(root, 'index.json'))).toBe(false);
  });

  it('a corrupt session.json keeps its index entry (no auto-delete)', async () => {
    const store = new SessionStore(root);
    const { session: healthy } = await store.newSession('good');
    const { session: broken } = await store.newSession('bad');
    await writeFile(join(root, broken.id, 'session.json'), 'not json at all', 'utf8');

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([healthy.id]);

    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(idx.sessions.map((e) => e.id).sort()).toEqual([healthy.id, broken.id].sort());
  });

  it('concurrent saves of the same session do not corrupt session.json', async () => {
    const store = new SessionStore(root);
    const { session } = await store.newSession('racer');
    session.tiles = [{ agentId: 'agent-1', cwd: '/tmp' }];
    const s2 = JSON.parse(JSON.stringify(session)) as typeof session;
    s2.tiles.push({ agentId: 'agent-2', cwd: '/tmp' });
    await Promise.all([store.save(session), store.save(s2), store.save(session)]);
    const reloaded = await store.load(session.id);
    // whichever save won the race, the file must parse and be intact
    expect(reloaded.version).toBe(1);
    expect([1, 2]).toContain(reloaded.tiles.length);
  });
});
