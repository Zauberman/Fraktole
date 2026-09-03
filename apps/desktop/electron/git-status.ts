import { spawn } from 'node:child_process';
import type { GitMark, GitStatus } from '../src/shared/ipc.js';

const GIT_TIMEOUT_MS = 3000;
// matches the renderer's 5s poll: the cache must cover the full period or
// every poll spawns a fresh `git status`
const CACHE_TTL_MS = 5000;

const statusCache = new Map<string, { at: number; status: GitStatus | null }>();

/** Decodes a core.quotePath C-quoted path ("caf\303\251.md" → café.md).
 *  High bytes are buffered and decoded as UTF-8; returns null when the
 *  quoting cannot be decoded — the row is skipped. */
function unquoteGitPath(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  let out = '';
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8');
      bytes = [];
    }
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      flush();
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) return null;
    if (n === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (n >= '0' && n <= '7' && /^[0-7]{2}$/.test(body.slice(i + 1, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else if (n === 't') { flush(); out += '\t'; }
    else if (n === 'n') { flush(); out += '\n'; }
    else if (n === 'r') { flush(); out += '\r'; }
    else if (n === '"') { flush(); out += '"'; }
    else if (n === '\\') { flush(); out += '\\'; }
    else return null;
  }
  flush();
  return out;
}

/** Parses one porcelain row (XY + path) into a root-relative path + mark.
 *  Returns null for rows that carry no supported mark or an undecodable
 *  quoted path. */
function parseRow(row: string): { path: string; mark: GitMark } | null {
  if (row.length < 4) return null;
  const x = row[0]!;
  const y = row[1]!;
  if (row[2] !== ' ') return null;
  if (x === '?' && y === '?') {
    const p = unquoteGitPath(row.slice(3));
    return p ? { path: p, mark: '?' } : null;
  }
  let mark: GitMark;
  if (x === 'M' || x === 'A' || x === 'D' || x === 'R') mark = x;
  else if (y === 'M' || y === 'A' || y === 'D' || y === 'R') mark = y;
  else return null;
  let rest = row.slice(3);
  if (mark === 'R') {
    const cut = rest.lastIndexOf(' -> ');
    if (cut < 0) return null;
    rest = rest.slice(cut + 4); // porcelain reports the NEW path
  }
  const p = unquoteGitPath(rest);
  return p ? { path: p, mark } : null;
}

/** Pure parser for `git status --porcelain=v1 -b` output. Untracked rows map
 *  to '?', rename rows map their NEW path to 'R', undecodable rows are
 *  skipped silently. */
export function parsePorcelain(output: string): { branch: string | null; entries: Record<string, GitMark> } {
  const entries: Record<string, GitMark> = {};
  let branch: string | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    if (line.startsWith('## ')) {
      let head = line.slice(3);
      const bracket = head.indexOf(' [');
      if (bracket >= 0) head = head.slice(0, bracket);
      const dots = head.indexOf('...');
      if (dots >= 0) head = head.slice(0, dots);
      if (head.startsWith('No commits yet on ')) head = head.slice('No commits yet on '.length);
      branch = head.startsWith('HEAD (no branch)') ? null : head.length > 0 ? head : null;
      continue;
    }
    const row = parseRow(line);
    if (row) entries[row.path] = row.mark;
  }
  return { branch, entries };
}

function runGitStatus(projectPath: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'git',
      ['-C', projectPath, 'status', '--porcelain=v1', '-b', '--untracked-files=normal'],
      { windowsHide: true },
    );
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve(null);
        return;
      }
      resolve(parsePorcelain(stdout));
    });
  });
}

/** Branch + change marks for a project root, or null when git is missing,
 *  the path is not a repo, or the call fails/times out. Cached per path for
 *  3s so pollers sharing the cadence do not spawn a git process each. */
export async function collectGitStatus(projectPath: string): Promise<GitStatus | null> {
  const cached = statusCache.get(projectPath);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.status;
  const status = await runGitStatus(projectPath);
  statusCache.set(projectPath, { at: Date.now(), status });
  return status;
}
