import { useEffect, useRef, useState } from 'react';
import { bridge, type GitStatus } from '../../ipc.js';

const GIT_POLL_MS = 5000;

/** Git branch + change marks for the active project root: polled every 5s
 *  and immediately on mount/project change. null = not a repo (or git
 *  unavailable). Byte-identical polls never commit a new status object, so
 *  the poll cannot re-render consumers that only compare identity. */
export function useGitStatus(projectPath: string | null): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const lastJson = useRef('');
  useEffect(() => {
    lastJson.current = '';
    if (projectPath === null) {
      setStatus(null);
      return;
    }
    let alive = true;
    const poll = (): void => {
      void bridge
        .gitStatus(projectPath)
        .then((s) => {
          if (!alive) return;
          const json = JSON.stringify(s);
          if (json === lastJson.current) return;
          lastJson.current = json;
          setStatus(s);
        })
        .catch(() => undefined);
    };
    poll();
    const id = window.setInterval(poll, GIT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [projectPath]);
  return status;
}

/** Resolves the change mark for an absolute entry path: entries are keyed
 *  by root-relative POSIX paths, so compare normalized suffixes. */
export function gitMarkFor(absPath: string, root: string, status: GitStatus | null): string | null {
  return makeGitMarkLookup(status)(absPath, root);
}

export type GitMarkLookup = (absPath: string, root: string) => string | null;

/** Precomputes a Map from the status entries once per status object so row
 *  lookups are O(depth suffix walk) instead of O(all entries). Equivalent
 *  semantics to the linear scan: exact rel-path match first, then any
 *  `/`-anchored suffix (a file inside a reported directory). */
export function makeGitMarkLookup(status: GitStatus | null): GitMarkLookup {
  if (status === null) return () => null;
  const entries = new Map(Object.entries(status.entries));
  return (absPath: string, root: string): string | null => {
    const norm = absPath.replace(/\\/g, '/');
    const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
    const rel = norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : null;
    if (rel === null) return null;
    let idx = 0;
    for (;;) {
      const mark = entries.get(rel.slice(idx));
      if (mark) return mark;
      const next = rel.indexOf('/', idx + 1);
      if (next === -1) return null;
      idx = next + 1;
    }
  };
}
