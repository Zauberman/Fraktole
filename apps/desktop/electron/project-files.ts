import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_SKIP_DIRS } from './skip-dirs.js';

/** Quick-open (Ctrl+P): bounded walk of a project root → file list. The
 *  result is cached per root for a few seconds so repeated palette opens are
 *  instant; the walk itself skips heavy/recursive dirs and hidden entries. */
const QUICK_OPEN_MAX = 5000;
const QUICK_OPEN_SKIP = PROJECT_SKIP_DIRS;
let quickOpenCache: { root: string; at: number; files: Array<{ name: string; path: string }> } | null = null;

export async function listProjectFiles(root: string): Promise<Array<{ name: string; path: string }>> {
  if (quickOpenCache && quickOpenCache.root === root && Date.now() - quickOpenCache.at < 10_000) {
    return quickOpenCache.files;
  }
  const files: Array<{ name: string; path: string }> = [];
  const stack = [root];
  while (stack.length > 0 && files.length < QUICK_OPEN_MAX) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip the subtree
    }
    for (const e of entries) {
      if (files.length >= QUICK_OPEN_MAX) break;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!QUICK_OPEN_SKIP.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile() || e.isSymbolicLink()) {
        files.push({ name: e.name, path: join(dir, e.name) });
      }
    }
  }
  quickOpenCache = { root, at: Date.now(), files };
  return files;
}
