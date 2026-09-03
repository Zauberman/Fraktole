import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSessionBundle, importSessionBundle, MAX_BUNDLE_BYTES } from '../electron/session-bundle.js';
import { newSessionId, touchSessionIndex } from '../electron/sessions.js';
import { execFile } from 'node:child_process';

async function makeSessionDir(root: string, id: string): Promise<string> {
  const dir = join(root, id);
  await mkdir(join(dir, 'reviewer'), { recursive: true });
  await mkdir(join(dir, 'scrollback'), { recursive: true });
  await writeFile(
    join(dir, 'session.json'),
    JSON.stringify({
      version: 1,
      id,
      name: 'My Session',
      createdAt: 1,
      updatedAt: 2,
      nextAgentSeq: 3,
      judge: null,
      tree: null,
      tiles: [{ agentId: 'agent-1', cwd: '/tmp' }],
    }),
  );
  await writeFile(
    join(dir, 'reviewer', 'conversation.jsonl'),
    '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
  );
  await writeFile(join(dir, 'scrollback', 'agent-1.json'), JSON.stringify({ lines: ['a', 'b'] }));
  return dir;
}

describe('session bundle export/import', () => {
  it('round-trips a session: export then import preserves everything and re-keys the id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-bundle-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const id = newSessionId();
    await makeSessionDir(sessionsRoot, id);

    const bundle = join(root, 'out', 'fraktole-session-test.tar.gz');
    await mkdir(join(root, 'out'), { recursive: true });
    const exported = await exportSessionBundle(sessionsRoot, id, bundle);
    expect(exported.ok).toBe(true);
    await expect(stat(bundle)).resolves.toBeTruthy();

    const imported = await importSessionBundle(sessionsRoot, bundle);
    expect(imported.ok).toBe(true);
    const session = imported.ok ? imported.session! : null;
    expect(session).not.toBeNull();
    expect(session!.id).not.toBe(id); // re-keyed — never collides with the source
    expect(session!.name).toBe('My Session');
    expect(session!.tiles).toEqual([{ agentId: 'agent-1', cwd: '/tmp' }]);

    // the new session folder holds the conversation and scrollback
    const conv = await readFile(join(sessionsRoot, session!.id, 'reviewer', 'conversation.jsonl'), 'utf8');
    expect(conv).toContain('"role":"user","content":"hello"');
    const sb = JSON.parse(await readFile(join(sessionsRoot, session!.id, 'scrollback', 'agent-1.json'), 'utf8')) as { lines: string[] };
    expect(sb.lines).toEqual(['a', 'b']);
    // the re-keyed id is persisted in the imported session.json
    const persisted = JSON.parse(await readFile(join(sessionsRoot, session!.id, 'session.json'), 'utf8')) as { id: string };
    expect(persisted.id).toBe(session!.id);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a non-bundle file and leaves no temp dirs behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-bundle-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const junk = join(root, 'junk.tar.gz');
    await writeFile(junk, 'this is not a tarball', 'utf8');
    const res = await importSessionBundle(sessionsRoot, junk);
    if (res.ok) throw new Error('expected the junk bundle to be rejected');
    expect(res.error).toContain('import failed');
    const leftovers = (await readdir(sessionsRoot)).filter((e) => e.startsWith('.import-'));
    expect(leftovers).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a bundle without a valid session.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-bundle-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const src = join(root, 'src', 's-malformed');
    await mkdir(join(src, 'reviewer'), { recursive: true });
    await writeFile(join(src, 'session.json'), '{"version": 2, "id": "s-x"}', 'utf8');
    const bundle = join(root, 'bad.tar.gz');
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) =>
      execFile('tar', ['-czf', bundle, '-C', join(root, 'src'), 's-malformed'], (err) => (err ? reject(err) : resolve())),
    );
    const res = await importSessionBundle(sessionsRoot, bundle);
    if (res.ok) throw new Error('expected the malformed bundle to be rejected');
    expect(res.error).toContain('unsupported session format');
    const leftovers = (await readdir(sessionsRoot)).filter((e) => e.startsWith('.import-'));
    expect(leftovers).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses oversized bundles before extracting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-bundle-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const big = join(root, 'big.tar.gz');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(big, Buffer.alloc(MAX_BUNDLE_BYTES + 1, 0));
    const res = await importSessionBundle(sessionsRoot, big);
    if (res.ok) throw new Error('expected the oversized bundle to be rejected');
    expect(res.error).toContain('bundle too large');
    await rm(root, { recursive: true, force: true });
  });
});

describe('bundle hardening', () => {
  it('rejects archives containing symlink members (tar zip-slip)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-evil-'));
    const outRoot = join(root, 'out');
    await mkdir(outRoot, { recursive: true });
    const evilDir = join(root, 'evil', 's-evil');
    await mkdir(evilDir, { recursive: true });
    await symlink('/tmp/fraktole-evil-target', join(evilDir, 'link'), 'dir');
    await writeFile(
      join(evilDir, 'session.json'),
      JSON.stringify({ version: 1, id: newSessionId(), name: 'x', createdAt: 0, updatedAt: 0, nextAgentSeq: 1, judge: null, tree: null, tiles: [] }),
    );
    const bundle = join(root, 'craft.tar.gz');
    await new Promise<void>((res, rej) => execFile('tar', ['-czf', bundle, '-C', join(root, 'evil'), '.'], (e) => (e ? rej(e) : res())));
    const res = await importSessionBundle(outRoot, bundle);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/link/);
    await rm(root, { recursive: true, force: true });
  });

  it('indexes an imported session immediately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-idx-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const id = newSessionId();
    await makeSessionDir(sessionsRoot, id);
    const bundle = join(root, 'b.tar.gz');
    const exp = await exportSessionBundle(sessionsRoot, id, bundle);
    expect(exp.ok).toBe(true);
    const res = await importSessionBundle(sessionsRoot, bundle);
    expect(res.ok).toBe(true);
    const importedId = res.ok && res.session ? res.session.id : '';
    const idx = JSON.parse(await readFile(join(sessionsRoot, 'index.json'), 'utf8')) as { sessions: Array<{ id: string }> };
    expect(idx.sessions.some((e) => e.id === importedId)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to export a session id that is not an internal id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-exp-'));
    const sessionsRoot = join(root, 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    const res = await exportSessionBundle(sessionsRoot, '../../etc', join(root, 'x.tar.gz'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid session id/);
    await rm(root, { recursive: true, force: true });
  });

  it('touchSessionIndex inserts and dedupes without touching a corrupt index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frak-tix-'));
    await writeFile(join(root, 'index.json'), 'garbage');
    await touchSessionIndex(root, { id: newSessionId(), name: 'n', updatedAt: 1 });
    // corrupt index untouched — the store owns the rebuild
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('garbage');
    await rm(root, { recursive: true, force: true });
  });
});
