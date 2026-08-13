import { spawn, type ChildProcess } from 'node:child_process';

/** Long-running processes started by the reviewer (run_background). One
 *  registry per session: children die with the session (stopAll), output is
 *  kept in a capped ring so the reviewer can poll progress with job_status. */

export interface JobInfo {
  jobId: string;
  pid: number;
  state: 'running' | 'exited';
  code: number | null;
  output: string;
}

export interface JobRegistryOpts {
  maxJobs?: number;
  outputCap?: number;
  logger?: (line: string) => void;
}

let jobSeq = 0;

export class JobRegistry {
  private readonly jobs = new Map<string, JobInfo>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly maxJobs: number;
  private readonly outputCap: number;
  private readonly logger: (line: string) => void;

  constructor(opts: JobRegistryOpts = {}) {
    this.maxJobs = opts.maxJobs ?? 4;
    this.outputCap = opts.outputCap ?? 32 * 1024;
    this.logger = opts.logger ?? (() => undefined);
  }

  start(command: string, cwd: string): { jobId: string; pid: number } | { error: string } {
    if (this.jobs.size >= this.maxJobs) {
      return { error: `job cap (${this.maxJobs}) reached — stop one first` };
    }
    const jobId = `j-${Date.now()}-${++jobSeq}`;
    const info: JobInfo = { jobId, pid: 0, state: 'running', code: null, output: '' };
    this.jobs.set(jobId, info);
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env: { ...process.env, PWD: cwd } });
    info.pid = child.pid ?? 0;
    this.children.set(jobId, child);
    const push = (chunk: Buffer | string): void => {
      info.output = `${info.output}${chunk.toString()}`.slice(-this.outputCap);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('exit', (code) => {
      info.state = 'exited';
      info.code = code;
      this.children.delete(jobId);
      this.logger(`job ${jobId} exited (${String(code)})`);
    });
    child.on('error', (err) => {
      push(`\n[error: ${err.message}]`);
      info.state = 'exited';
      info.code = -1;
      this.children.delete(jobId);
    });
    this.logger(`job ${jobId} started (pid ${info.pid}): ${command}`);
    return { jobId, pid: info.pid };
  }

  status(jobId: string): JobInfo | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** SIGTERM with a 2s SIGKILL escalation (same pattern as the PTY host). */
  stop(jobId: string): boolean {
    const child = this.children.get(jobId);
    if (!child) return false;
    const info = this.jobs.get(jobId);
    try {
      child.kill('SIGTERM');
    } catch {
      return false;
    }
    if (info) info.output = `${info.output}\n[stopped by job_stop]`.slice(-this.outputCap);
    const escalation = setTimeout(() => {
      const c = this.children.get(jobId);
      if (c) {
        try {
          c.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 2_000);
    escalation.unref();
    return true;
  }

  stopAll(): void {
    for (const jobId of [...this.children.keys()]) this.stop(jobId);
  }
}
