import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRegistry } from '../electron/jobs.js';

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('JobRegistry', () => {
  it('runs a command to completion and records output', async () => {
    const registry = new JobRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-jobs-'));
    const res = registry.start('echo JOB-42; echo more >&2', dir);
    if ('error' in res) throw new Error('start refused');
    expect(res.pid).toBeGreaterThan(0);
    await settle(400);
    const info = registry.status(res.jobId);
    expect(info?.state).toBe('exited');
    expect(info?.code).toBe(0);
    expect(info?.output).toContain('JOB-42');
    expect(info?.output).toContain('more');
  });

  it('caps the output ring', async () => {
    const registry = new JobRegistry({ outputCap: 512 });
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-jobs-'));
    const res = registry.start('for i in $(seq 1 200); do echo "line number $i with padding"; done', dir);
    if ('error' in res) throw new Error('start refused');
    await settle(800);
    const info = registry.status(res.jobId);
    expect(info?.state).toBe('exited');
    expect(info!.output.length).toBeLessThanOrEqual(512);
  });

  it('stop kills a running job', async () => {
    const registry = new JobRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-jobs-'));
    const res = registry.start('sleep 30', dir);
    if ('error' in res) throw new Error('start refused');
    expect(registry.stop(res.jobId)).toBe(true);
    await settle(500);
    const info = registry.status(res.jobId);
    expect(info?.state).toBe('exited');
    expect(info?.output).toContain('stopped by job_stop');
    expect(registry.stop(res.jobId)).toBe(false); // already gone
  });

  it('refuses jobs beyond the cap', async () => {
    const registry = new JobRegistry({ maxJobs: 2 });
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-jobs-'));
    const a = registry.start('sleep 10', dir);
    const b = registry.start('sleep 10', dir);
    const c = registry.start('sleep 10', dir);
    expect('error' in a).toBe(false);
    expect('error' in b).toBe(false);
    if ('error' in c) {
      expect(c.error).toContain('job cap');
    } else {
      throw new Error('third job should have been refused');
    }
  });

  it('stopAll kills every job', async () => {
    const registry = new JobRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-jobs-'));
    const a = registry.start('sleep 30', dir);
    const b = registry.start('sleep 30', dir);
    if ('error' in a || 'error' in b) throw new Error('start refused');
    registry.stopAll();
    await settle(500);
    expect(registry.status(a.jobId)?.state).toBe('exited');
    expect(registry.status(b.jobId)?.state).toBe('exited');
  });
});
