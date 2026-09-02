import { useEffect, useState } from 'react';
import { bridge, type GitStatus } from '../../ipc.js';

const GIT_POLL_MS = 5000;

/** Git branch + change marks for the active project root: polled every 5s
 *  and immediately on mount/project change. null = not a repo (or git
 *  unavailable). Exported so the status bar can reuse the same feed. */
export function useGitStatus(projectPath: string | null): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (projectPath === null) {
      setStatus(null);
      return;
    }
    let alive = true;
    const poll = (): void => {
      void bridge
        .gitStatus(projectPath)
        .then((s) => {
          if (alive) setStatus(s);
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
  if (status === null) return null;
  const norm = absPath.replace(/\\/g, '/');
  const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  const rel = norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : null;
  for (const [key, mark] of Object.entries(status.entries)) {
    if (rel === key || (rel !== null && rel.endsWith(`/${key}`))) return mark;
  }
  return null;
}
