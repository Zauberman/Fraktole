import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_PATH, loadConfig, type EventEnvelope, type Task } from '@fraktole/core';
import { runDaemon, type Daemon } from '@fraktole/daemon';
import { createFraktoleServer } from '@fraktole/daemon/server.js';
import WebSocket from 'ws';
import { type CmdContext, apiRequest } from '../src/client.js';
import { cmdCancel, cmdDispatch, followLogs } from '../src/commands.js';

const TOKEN = 'integration-token';
const INSTALLED = [{ id: 'opencode', command: 'opencode', installed: true }];

let daemon: Daemon;
let ctx: CmdContext;
let releaseRun: () => void;
let closeServer: () => Promise<void>;
const openSockets = new Set<WebSocket>();

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-cli-'));
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir: join(dir, 'data'),
      server: { tokens: [TOKEN] },
      limits: { maxConcurrent: 1 },
    }),
  );
  const held = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  daemon = await runDaemon(configPath, {
    plan: async () => ({ tasks: [], rationale: 'x' }),
    run: async () => {
      await held;
    },
  });
  const server = createFraktoleServer({
    engine: daemon.engine,
    bus: daemon.bus,
    tokens: [TOKEN],
    drivers: INSTALLED,
    repos: daemon.repos,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  closeServer = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  ctx = {
    configPath,
    config: await loadConfig(configPath),
    opts: { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN },
  };
});

afterAll(async () => {
  releaseRun();
  for (const ws of openSockets) ws.close();
  await new Promise((r) => setTimeout(r, 50));
  await closeServer();
});

describe('CLI to daemon round-trip', () => {
  it('dispatch -> status -> cancel with correct gate semantics', async () => {
    await cmdDispatch(ctx, 'held task', { repo: '/tmp/scratch-repo' });
    await cmdDispatch(ctx, 'queued task', { repo: '/tmp/scratch-repo' });

    const { data } = await apiRequest<{ tasks: Task[] }>(ctx.opts, 'GET', '/v1/tasks');
    const held = data.tasks.find((t) => t.goal === 'held task');
    const queued = data.tasks.find((t) => t.goal === 'queued task');
    expect(held?.status).toBe('running');
    expect(queued?.status).toBe('queued');

    await cmdCancel(ctx, queued!.id);
    const after = await apiRequest<{ tasks: Task[] }>(ctx.opts, 'GET', '/v1/tasks');
    expect(after.data.tasks.find((t) => t.id === queued!.id)?.status).toBe('cancelled');

    await expect(
      fetch(`${ctx.opts.baseUrl}/v1/tasks/${held!.id}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ).resolves.toMatchObject({ status: 409 });
  });

  it('receives a WS TaskCreated event for a dispatched task', async () => {
    const taskCreated = new Promise<Task>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no TaskCreated event received')), 5000);
      void followEvents(ctx, (ev) => {
        if (ev.kind === 'TaskCreated' && ev.payload.task.goal === 'ws task') {
          clearTimeout(timer);
          resolve(ev.payload.task);
        }
      });
    });

    await cmdDispatch(ctx, 'ws task', { repo: '/tmp/scratch-repo' });
    const task = await taskCreated;
    expect(task.goal).toBe('ws task');
  });

  it('auto-targets and registers the cwd repo when --repo is omitted', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'fraktole-cwd-repo-'));
    const execFileP = promisify(execFile);
    await execFileP('git', ['init', '-b', 'main'], { cwd: repo });
    await execFileP('git', ['config', 'user.email', 't@t'], { cwd: repo });
    await execFileP('git', ['config', 'user.name', 'T'], { cwd: repo });
    await writeFile(join(repo, 'f.txt'), 'x\n');
    await execFileP('git', ['add', '.'], { cwd: repo });
    await execFileP('git', ['commit', '-m', 'init'], { cwd: repo });

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      await cmdDispatch(ctx, 'cwd repo task', {});
    } finally {
      process.chdir(cwd);
    }

    const { data } = await apiRequest<{ repos: Array<{ path: string }> }>(
      ctx.opts,
      'GET',
      '/v1/repos',
    );
    expect(data.repos.some((r) => r.path === repo)).toBe(true);
  });

  it('follows LogChunk events for a task', async () => {    const chunks: string[] = [];
    const done = new Promise<void>((resolve) => {
      void followLogs(
        ctx,
        'logtask',
        (ev) => {
          chunks.push(ev.payload.text);
          if (chunks.length >= 2) resolve();
        },
        (ws) => openSockets.add(ws),
      );
    });
    daemon.bus.publish('LogChunk', 'logtask', { taskId: 'logtask', stream: 'stdout', text: 'hello ' });
    daemon.bus.publish('LogChunk', 'logtask', { taskId: 'logtask', stream: 'stdout', text: 'world\n' });
    await done;
    expect(chunks.join('')).toBe('hello world\n');
  });
});

function followEvents(ctx: CmdContext, onEvent: (ev: EventEnvelope) => void): Promise<void> {
  const ws = new WebSocket(`${ctx.opts.baseUrl.replace(/^http/, 'ws')}${WS_PATH}`, {
    headers: { authorization: `Bearer ${ctx.opts.token}` },
  });
  openSockets.add(ws);
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'get', since: -1 })));
    ws.on('message', (data) => onEvent(JSON.parse(String(data)) as EventEnvelope));
    ws.on('error', reject);
    ws.on('close', () => {
      openSockets.delete(ws);
      resolve();
    });
  });
}
