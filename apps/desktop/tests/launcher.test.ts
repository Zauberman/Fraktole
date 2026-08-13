import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** The launcher must survive an app-menu-style environment: no TERM, no
 *  COLORTERM (terminal-only vars), no SHELL/USER/LOGNAME guarantees, and a
 *  stripped PATH. It died on `COLORTERM: unbound variable` with set -u —
 *  this test is the regression guard for that bug class. */

const LAUNCHER = join(import.meta.dirname, '..', 'scripts', 'launcher.sh');

function runLauncher(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [LAUNCHER],
      {
        env,
        // FRAKTOLE_REAL_BIN=/bin/true → the script must exec it and exit 0
      },
      (err, _stdout, stderr) => {
        resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr });
      },
    );
  });
}

describe('launcher.sh under a menu-like environment', () => {
  it('execs the binary without unbound-variable aborts (no TERM/COLORTERM)', async () => {
    const { code, stderr } = await runLauncher({
      HOME: '/home/test',
      PATH: '/usr/bin:/bin',
      FRAKTOLE_REAL_BIN: '/bin/true',
    });
    expect(stderr, `launcher stderr: ${stderr}`).toBe('');
    expect(code).toBe(0);
  });

  it('passes a deliberately empty TERM through without erroring', async () => {
    const { code, stderr } = await runLauncher({
      HOME: '/home/test',
      PATH: '/usr/bin:/bin',
      TERM: '',
      COLORTERM: '',
      FRAKTOLE_REAL_BIN: '/bin/true',
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('keeps proxy and locale passthrough harmless under an empty env', async () => {
    const { code, stderr } = await runLauncher({
      HOME: '/home/test',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      LC_ALL: 'C.UTF-8',
      FRAKTOLE_REAL_BIN: '/bin/true',
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('refuses to run without a binary (the exec-guard path)', async () => {
    const { code, stderr } = await runLauncher({ HOME: '/home/test', PATH: '/usr/bin:/bin' });
    expect(code).toBe(1);
    expect(stderr).toContain('no binary given');
  });
});
