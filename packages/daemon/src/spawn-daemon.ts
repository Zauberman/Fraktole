import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the daemon entry. In the bundled distribution the daemon bundle sits
 * next to this module; in dev mode it resolves through the workspace package.
 */
export function resolveDaemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ['fraktole-daemon.cjs', 'fraktole-daemon.mjs']) {
    const bundled = join(here, name);
    if (existsSync(bundled)) return bundled;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@fraktole/daemon/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> };
    return join(dirname(pkgPath), pkg.bin['fraktole-daemon']!);
  } catch {
    return join(here, 'fraktole-daemon.cjs');
  }
}

export interface EnsureDaemonOpts {
  configPath?: string;
  healthCheck: () => Promise<boolean>;
  waitMs?: number;
}

/**
 * Spawns the daemon detached when the health check fails, then polls until it
 * becomes reachable. Never spawns twice: the pidfile guards concurrent boots.
 */
export async function ensureDaemon(opts: EnsureDaemonOpts): Promise<boolean> {
  const { healthCheck, configPath, waitMs = 5_000 } = opts;
  try {
    if (await healthCheck()) return true;
  } catch {
    // unreachable — spawn below
  }
  const child = spawn(process.execPath, [resolveDaemonEntry()], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(configPath ? { FRAKTOLE_CONFIG: configPath } : {}) },
  });
  child.unref();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      if (await healthCheck()) return true;
    } catch {
      // keep polling
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
