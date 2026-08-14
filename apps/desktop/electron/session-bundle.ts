import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionFile } from '../src/shared/ipc.js';
import { newSessionId } from './sessions.js';

export type BundleResult =
  | { ok: true; path?: string; session?: SessionFile }
  | { ok: false; canceled?: boolean; error: string };

/** Upper bound for an importable bundle — protects the main process from a
 *  multi-GB archive before extraction even starts. */
export const MAX_BUNDLE_BYTES = 500 * 1024 * 1024;

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** Packages a session folder as a tar.gz (Linux-only app; tar is POSIX
 *  core). The archive contains the session dir with its id as the single
 *  top-level folder — the exact shape importSessionBundle expects. */
export async function exportSessionBundle(sessionsRoot: string, id: string, dest: string): Promise<BundleResult> {
  try {
    await stat(join(sessionsRoot, id));
    await execFileP('tar', ['-czf', dest, '-C', sessionsRoot, id]);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: `export failed: ${(err as Error).message}` };
  }
}

/** Validates a bundle and installs it as a NEW session (re-keyed with a
 *  fresh id — importing never overwrites an existing session). The bundle
 *  must be a tar.gz whose single top-level folder holds a valid
 *  session.json; everything else (reviewer conversation, scrollbacks,
 *  mailboxes) is carried over as-is and picked up by the runtime. */
export async function importSessionBundle(sessionsRoot: string, bundleFile: string): Promise<BundleResult> {
  const tmp = join(sessionsRoot, `.import-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const st = await stat(bundleFile);
    if (st.size > MAX_BUNDLE_BYTES) {
      return { ok: false, error: `bundle too large (${(st.size / 1024 / 1024).toFixed(0)} MB, cap 500 MB)` };
    }
    const listing = (await execFileP('tar', ['-tzf', bundleFile])).split('\n').filter((l) => l.length > 0);
    if (listing.length === 0) return { ok: false, error: 'invalid bundle: empty archive' };
    for (const entry of listing) {
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        return { ok: false, error: 'invalid bundle: unsafe path in archive' };
      }
    }
    const topDirs = new Set(listing.map((f) => f.split('/')[0]));
    if (topDirs.size !== 1) return { ok: false, error: 'invalid bundle: expected a single session folder' };
    const topDir = [...topDirs][0]!;
    if (!listing.includes(`${topDir}/session.json`)) return { ok: false, error: 'invalid bundle: session.json missing' };

    await mkdir(tmp, { recursive: true });
    await execFileP('tar', ['-xzf', bundleFile, '-C', tmp]);
    const src = join(tmp, topDir);

    const raw = await readFile(join(src, 'session.json'), 'utf8');
    const session = JSON.parse(raw) as SessionFile;
    if (
      session.version !== 1 ||
      typeof session.id !== 'string' ||
      typeof session.name !== 'string' ||
      !Array.isArray(session.tiles) ||
      typeof session.nextAgentSeq !== 'number'
    ) {
      throw new Error('unsupported session format in bundle');
    }
    // re-key: the imported session must never collide with an existing id
    const reKeyed: SessionFile = { ...session, id: newSessionId(), updatedAt: Date.now() };
    await writeFile(join(src, 'session.json'), JSON.stringify(reKeyed, null, 2), 'utf8');

    await rename(src, join(sessionsRoot, reKeyed.id));
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, session: reKeyed };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `import failed: ${(err as Error).message}` };
  }
}
