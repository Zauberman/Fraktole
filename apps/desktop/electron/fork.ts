import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ForkResult = { ok: true; path: string } | { ok: false; error: string };

/** Directories never carried into a fork — heavy or recursive by nature. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fraktole-auto', 'release']);
const MAX_ENTRIES = 50_000;

/** Clones (git) or copies the project into a fresh fork folder.
 *  - git repos with a clean worktree: `git clone --local` (fast, history).
 *  - dirty worktrees and non-git projects: recursive copy with exclusions,
 *    so uncommitted work is included.
 *  - the destination is reset first; forking the home directory is refused
 *  (there is no project to fork). */
export async function forkProject(src: string, dest: string, home: string): Promise<ForkResult> {
  let isDir = false;
  try {
    isDir = (await stat(src)).isDirectory();
  } catch {
    return { ok: false, error: 'project directory not found' };
  }
  if (!isDir) return { ok: false, error: 'project directory not found' };
  if (src === home) return { ok: false, error: 'no project to fork (cwd is the home directory)' };

  try {
    await rm(dest, { recursive: true, force: true });
  } catch {
    // best effort — the fresh write below will surface real failures
  }

  const cleanWorktree = await new Promise<boolean>((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: src, timeout: 15_000 }, (err, out) => {
      resolve(err === null && out.trim().length === 0);
    });
  });

  if (cleanWorktree) {
    const cloned = await new Promise<boolean>((resolve) => {
      execFile('git', ['clone', '--local', '--quiet', src, dest], { timeout: 120_000 }, (err, _out, stderr) => {
        if (err) console.error(`[fork] git clone failed (${err.message}): ${String(stderr).slice(0, 300)}`);
        resolve(err === null);
      });
    });
    if (cloned) return { ok: true, path: dest };
    // clone failed — fall through to the copy
  }

  let count = 0;
  try {
    await mkdir(dest, { recursive: true });
    const walk = async (from: string, to: string): Promise<boolean> => {
      const entries = await readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (++count > MAX_ENTRIES) return false;
        const s = join(from, entry.name);
        const t = join(to, entry.name);
        if (entry.isDirectory()) {
          await mkdir(t, { recursive: true });
          if (!(await walk(s, t))) return false;
        } else {
          await copyFile(s, t);
        }
      }
      return true;
    };
    if (!(await walk(src, dest))) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: 'project too large to fork' };
    }
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: `fork failed: ${(err as Error).message}` };
  }
}
