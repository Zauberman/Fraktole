import type { Task } from '@fraktole/core';
import type { EventBus } from './event-bus.js';
import type { DriverRegistry } from './drivers/index.js';

const KILL_GRACE_MS = 5_000;

export const AGENT_GATE_MARKER = /^FRAKTOLE-GATE:\s*(.+)$/;

export interface RunnerDeps {
  bus: EventBus;
  registry: DriverRegistry;
  defaultTimeoutMs: number;
  /** called (with taskId and reason) when an agent emits a FRAKTOLE-GATE marker */
  onAgentGate?: (taskId: string, reason: string) => void;
}

export class AgentRunner {
  private readonly bus: EventBus;
  private readonly registry: DriverRegistry;
  private readonly defaultTimeoutMs: number;
  private readonly onAgentGate?: (taskId: string, reason: string) => void;

  constructor(deps: RunnerDeps) {
    this.bus = deps.bus;
    this.registry = deps.registry;
    this.defaultTimeoutMs = deps.defaultTimeoutMs;
    this.onAgentGate = deps.onAgentGate;
  }

  /**
   * forwards a chunk to the log, line by line, stripping FRAKTOLE-GATE markers.
   * A marker split across chunk boundaries is not detected (documented).
   */
  private forward(chunk: string, stream: 'stdout' | 'stderr', taskId: string): void {
    if (!this.onAgentGate) {
      this.bus.publish('LogChunk', taskId, { taskId, stream, text: chunk });
      return;
    }
    const parts = chunk.split('\n');
    const tail = parts.pop() ?? '';
    let buffer = '';
    const flush = (): void => {
      if (buffer.length > 0) {
        this.bus.publish('LogChunk', taskId, { taskId, stream, text: buffer });
        buffer = '';
      }
    };
    for (const line of parts) {
      const match = AGENT_GATE_MARKER.exec(line);
      if (match) {
        flush();
        this.onAgentGate(taskId, match[1]!);
      } else {
        buffer += `${line}\n`;
      }
    }
    const tailMatch = AGENT_GATE_MARKER.exec(tail);
    if (tailMatch) {
      flush();
      this.onAgentGate(taskId, tailMatch[1]!);
    } else {
      buffer += tail;
    }
    flush();
  }

  async run(task: Task): Promise<void> {
    if (!task.worktreePath) throw new Error(`task ${task.id} has no worktree`);
    const driver = this.registry.get(task.driver);
    const child = driver.spawn(
      {
        worktreePath: task.worktreePath,
        goal: task.goal,
        env: {},
        taskId: task.id,
      },
      {
        onStdout: (chunk) => this.forward(chunk, 'stdout', task.id),
        onStderr: (chunk) => this.forward(chunk, 'stderr', task.id),
        onExit: (code, signal) => {
          task.exitCode = code;
          this.bus.publish('AgentExited', task.id, { taskId: task.id, exitCode: code, signal });
        },
      },
    );
    task.pid = child.pid;
    this.bus.publish('AgentSpawned', task.id, { taskId: task.id, driver: task.driver, pid: child.pid });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, this.defaultTimeoutMs);

    await child.exited;
    clearTimeout(timer);
    if (timedOut) {
      throw new Error(`task timed out after ${this.defaultTimeoutMs}ms`);
    }
    if (task.exitCode !== 0) {
      throw new Error(`agent exited with code ${task.exitCode ?? 'unknown'}`);
    }
  }
}
