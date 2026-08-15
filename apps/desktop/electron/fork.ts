import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export type ForkResult = { ok: true; path: string } | { ok: false; error: string };

/** True when dest exists as a NON-EMPTY directory. Re-entry uses this to
 *  decide whether a prior run's fork can be resumed in place — an empty or
 *  missing fork is treated as "no prior work". */
export async function forkExists(dest: string): Promise<boolean> {
  try {
    if (!(await stat(dest)).isDirectory()) return false;
    return (await readdir(dest)).length > 0;
  } catch {
    return false;
  }
}

/** Directories never carried into a fork — heavy or recursive by nature. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fraktole-auto', 'release']);
const MAX_ENTRIES = 50_000;
/** Error codes meaning "this entry is unreadable or not a plain file" — a
 *  fork is best-effort: one permission-denied file must not abort the whole
 *  run. EISDIR covers symlinks pointing at directories. */
const SKIPPABLE_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EISDIR']);

function isSkippable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code !== undefined && SKIPPABLE_CODES.has(code);
}

/** Clones (git) or copies the project into a fresh fork folder.
 *  - git repos with a clean worktree: `git clone --local` (fast, history).
 *  - dirty worktrees and non-git projects: recursive copy with exclusions,
 *    so uncommitted work is included.
 *  - the destination is reset first; forking the home directory is refused
 *  (there is no project to fork).
 *  - keepExisting: when the destination already holds a non-empty fork,
 *  reuse it untouched (resume-in-place) instead of wiping it. */
export async function forkProject(src: string, dest: string, home: string, keepExisting = false): Promise<ForkResult> {
  let isDir = false;
  try {
    isDir = (await stat(src)).isDirectory();
  } catch {
    return { ok: false, error: 'project directory not found' };
  }
  if (!isDir) return { ok: false, error: 'project directory not found' };
  if (src === home) return { ok: false, error: 'no project to fork (cwd is the home directory)' };

  if (keepExisting && (await forkExists(dest))) return { ok: true, path: dest };

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
    // clone failed — a partial .git may have been left behind; the copy
    // fallback skips dotfiles, so it must start from a clean destination
    // (otherwise the fork would carry a corrupt repo the agents run git on)
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
  }

  let count = 0;
  try {
    await mkdir(dest, { recursive: true });
    const walk = async (from: string, to: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(from, { withFileTypes: true });
      } catch (err) {
        if (isSkippable(err)) return true; // unreadable directory — skip the subtree
        throw err;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (++count > MAX_ENTRIES) return false;
        const s = join(from, entry.name);
        const t = join(to, entry.name);
        if (entry.isDirectory()) {
          await mkdir(t, { recursive: true });
          if (!(await walk(s, t))) return false;
        } else if (entry.isFile()) {
          try {
            await copyFile(s, t);
          } catch (err) {
            if (isSkippable(err)) continue; // unreadable — skip
            throw err;
          }
        } else if (entry.isSymbolicLink()) {
          // copyFile follows symlinks, so a link pointing OUTSIDE the project
          // (e.g. ~/.ssh/config) would leak its content into the fork — the
          // fork must stay self-contained. Resolve the real target and only
          // copy it when it stays inside the source tree.
          try {
            const resolved = await realpath(s);
            const root = resolve(src) + sep;
            if (resolved.startsWith(root) || resolved === resolve(src)) {
              await copyFile(resolved, t);
            }
            // outside the tree: skip (the fork loses the link, not the secret)
          } catch (err) {
            if (isSkippable(err)) continue; // broken link — skip
            throw err;
          }
        }
        // other entry types (fifo, socket, device) are never copied —
        // copying a fifo would block the fork forever
      }
      return true;
    };
    if (!(await walk(src, dest))) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: 'project too large to fork' };
    }
    return { ok: true, path: dest };
  } catch (err) {
    // never leave a partial fork behind on a failed copy
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `fork failed: ${(err as Error).message}` };
  }
}
