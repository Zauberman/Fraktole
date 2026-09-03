import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_SKIP_DIRS } from './skip-dirs.js';
import type { SearchHit, SearchResult } from '../src/shared/ipc.js';

const RG_TIMEOUT_MS = 4000;
const WALK_BUDGET_MS = 4000;
const MAX_HITS = 200;
const WALK_MAX_PER_FILE = 5;
const WALK_MAX_FILE_BYTES = 512 * 1024;

const RG_SKIP_GLOBS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.fraktole-auto'];

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'pdf', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'wasm', 'node',
  'class', 'jar', 'pyc', 'pyo', 'o', 'a', 'lib',
]);

/** Parses one `--no-heading --line-number` ripgrep row: path:line:text.
 *  Returns null for anything that is not a hit row (warnings etc.). */
export function parseRgLine(line: string): SearchHit | null {
  const m = /^(.+):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  const num = Number(m[2]);
  if (!Number.isInteger(num) || num <= 0) return null;
  return { path: m[1]!, line: num, text: m[3]! };
}

function searchWithRg(root: string, query: string): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    const skipArgs: string[] = [];
    for (const g of RG_SKIP_GLOBS) skipArgs.push('-g', `!${g}`);
    const child = spawn('rg', [
      '--no-heading',
      '--line-number',
      '--smart-case',
      '--fixed-strings',
      '--max-count',
      '5',
      '--no-messages',
      ...skipArgs,
      '-g',
      `!*.{${[...BINARY_EXTENSIONS].join(',')}}`,
      '-e',
      query,
      root,
    ], { windowsHide: true });

    let buf = '';
    const hits: SearchHit[] = [];
    let truncated = false;
    let timedOut = false;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ hits, truncated, engine: 'rg' });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      child.kill('SIGKILL');
    }, RG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (hits.length >= MAX_HITS) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        const hit = parseRgLine(line);
        if (hit) hits.push(hit);
      }
      if (hits.length >= MAX_HITS) {
        truncated = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (done) return;
      if (!timedOut && code !== null && code >= 2) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`rg exited with code ${code}`));
        return;
      }
      if (hits.length < MAX_HITS) {
        const hit = parseRgLine(buf);
        if (hit) hits.push(hit);
      }
      finish();
    });
  });
}

/** Case-insensitive literal walk fallback: bounded by the 200-hit cap, a
 *  4s budget, a 512KB per-file cap and 5 matches per file. */
export async function walkSearch(root: string, query: string): Promise<SearchResult> {
  const hits: SearchHit[] = [];
  const needle = query.toLowerCase();
  const startedAt = Date.now();
  let truncated = false;
  const stack = [root];
  while (stack.length > 0 && hits.length < MAX_HITS) {
    if (Date.now() - startedAt > WALK_BUDGET_MS) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip the subtree
    }
    for (const e of entries) {
      if (hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      if (Date.now() - startedAt > WALK_BUDGET_MS) {
        truncated = true;
        break;
      }
      if (e.name.startsWith('.') || PROJECT_SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const ext = e.name.includes('.') ? e.name.split('.').pop()!.toLowerCase() : '';
      if (BINARY_EXTENSIONS.has(ext)) continue;
      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        continue;
      }
      if (size > WALK_MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      let from = 0;
      let perFile = 0;
      while (perFile < WALK_MAX_PER_FILE && hits.length < MAX_HITS) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const lineStart = text.lastIndexOf('\n', at - 1) + 1;
        const lineEnd = text.indexOf('\n', at);
        hits.push({
          path: full,
          line: 1 + (text.slice(0, lineStart).match(/\n/g)?.length ?? 0),
          text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
        });
        perFile++;
        from = at + needle.length;
      }
    }
  }
  if (hits.length >= MAX_HITS) truncated = true;
  return { hits, truncated, engine: 'walk' };
}

/** Project-wide text search: ripgrep when installed, bounded JS walk
 *  otherwise. Empty queries short-circuit to no hits. */
export async function searchProject(root: string, query: string): Promise<SearchResult> {
  const q = query.trim();
  if (q.length === 0) return { hits: [], truncated: false, engine: 'walk' };
  try {
    return await searchWithRg(root, q);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return walkSearch(root, q);
    throw err;
  }
}
