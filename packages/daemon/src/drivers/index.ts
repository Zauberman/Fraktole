export interface DriverHooks {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface SpawnSpec {
  worktreePath: string;
  goal: string;
  env: Record<string, string>;
  taskId: string;
}

export interface DriverProcess {
  readonly pid: number;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<void>;
}

export interface AgentDriver {
  id: string;
  spawn(spec: SpawnSpec, hooks: DriverHooks): DriverProcess;
}

export interface SpawnedChild {
  pid?: number | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Wires a spawned child to the driver hooks. A failed spawn ('error' event)
 * resolves `exited` too: without this, a missing binary would hang the runner,
 * because 'exit' never fires for a process that never started.
 */
export function wireProcess(child: SpawnedChild, hooks: DriverHooks): DriverProcess {
  child.stdout?.on('data', (d: Buffer) => hooks.onStdout(d.toString()));
  child.stderr?.on('data', (d: Buffer) => hooks.onStderr(d.toString()));
  let done = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (done) return;
    done = true;
    hooks.onExit(code, signal);
  };
  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => {
    hooks.onStderr(`[driver] failed to spawn: ${err.message}\n`);
    finish(null, null);
  });
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
  return {
    pid: child.pid ?? 0,
    kill: (sig) => child.kill(sig),
    exited,
  };
}

export class UnknownDriverError extends Error {
  constructor(driverId: string) {
    super(`unknown agent driver: ${driverId}`);
    this.name = 'UnknownDriverError';
  }
}

export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>();

  register(driver: AgentDriver): void {
    this.drivers.set(driver.id, driver);
  }

  get(id: string): AgentDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new UnknownDriverError(id);
    return driver;
  }
}
