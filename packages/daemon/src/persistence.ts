import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventEnvelope, Task } from '@fraktole/core';
import { applyEventToState } from './task-engine.js';

export interface EngineState {
  version: 1;
  lastSeq: number;
  tasks: Record<string, Task>;
}

export function emptyState(): EngineState {
  return { version: 1, lastSeq: -1, tasks: {} };
}

export class Persistence {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  append(taskId: string, ev: EventEnvelope): Promise<void> {
    const line = `${JSON.stringify(ev)}\n`;
    this.chain = this.chain.then(
      async () => {
        const dir = join(this.dataDir, 'tasks');
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, `${taskId}.jsonl`), line, 'utf8');
      },
      async () => {
        throw new Error('persistence chain already failed');
      },
    );
    return this.chain as Promise<void>;
  }

  async snapshot(state: EngineState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tmp = join(this.dataDir, 'snapshot.json.tmp');
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, join(this.dataDir, 'snapshot.json'));
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async restore(): Promise<EngineState> {
    const state = emptyState();
    const snapPath = join(this.dataDir, 'snapshot.json');
    let snap: unknown;
    try {
      snap = JSON.parse(await readFile(snapPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (isRecord(snap) && isRecord(snap.tasks)) {
      state.tasks = snap.tasks as Record<string, Task>;
      if (typeof snap.lastSeq === 'number') state.lastSeq = snap.lastSeq;
    }
    const tasksDir = join(this.dataDir, 'tasks');
    const files = await readdir(tasksDir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
      const content = await readFile(join(tasksDir, file), 'utf8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        applyEventToState(state, JSON.parse(line) as EventEnvelope);
      }
    }
    return state;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
