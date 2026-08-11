import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_PATH, type EventEnvelope } from '@fraktole/core';
import WebSocket from 'ws';
import { runDaemon, type Daemon } from '../src/index.js';
import { createFraktoleServer } from '../src/server.js';

const TOKEN = 'test-token';
const INSTALLED = [{ id: 'opencode', command: 'opencode', installed: true }];

let daemon: Daemon;
let baseUrl: string;
let closeServer: () => Promise<void>;

let cancelDaemon: Daemon;
let cancelBaseUrl: string;
let closeCancelServer: () => Promise<void>;
let releaseRun: () => void;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-server-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir: join(dir, 'data'), server: { tokens: [TOKEN] } }));
  daemon = await runDaemon(configPath);
  const server = createFraktoleServer({
    engine: daemon.engine,
    bus: daemon.bus,
    tokens: [TOKEN],
    drivers: INSTALLED,
    decomposeDefault: false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // Dedicated daemon for cancel semantics: maxConcurrent 1, held run handler.
  const cdir = await mkdtemp(join(tmpdir(), 'fraktole-cancel-'));
  const ccfg = join(cdir, 'config.json');
  await writeFile(
    ccfg,
    JSON.stringify({
      dataDir: join(cdir, 'data'),
      server: { tokens: [TOKEN] },
      limits: { maxConcurrent: 1 },
    }),
  );
  const held = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  cancelDaemon = await runDaemon(ccfg, {
    plan: async () => ({ tasks: [], rationale: 'x' }),
    run: async () => {
      await held;
    },
  });
  const cancelServer = createFraktoleServer({
    engine: cancelDaemon.engine,
    bus: cancelDaemon.bus,
    tokens: [TOKEN],
    drivers: INSTALLED,
  });
  await new Promise<void>((resolve) => cancelServer.listen(0, '127.0.0.1', () => resolve()));
  cancelBaseUrl = `http://127.0.0.1:${(cancelServer.address() as AddressInfo).port}`;
  closeCancelServer = () => {
    cancelServer.closeAllConnections();
    return new Promise<void>((resolve) => cancelServer.close(() => resolve()));
  };
});

afterAll(async () => {
  releaseRun();
  await closeCancelServer();
  await closeServer();
});

async function waitForStatus(base: string, taskId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/v1/tasks/${taskId}`, { headers: auth });
    const body = (await res.json()) as { task: { status: string } };
    if (body.task.status === status) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${taskId} never reached status ${status}`);
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('REST API', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`);
    expect(res.status).toBe(401);
  });

  it('creates a task and lists it', async () => {
    const created = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'fix typo', repoPath: '/tmp/repo' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { task: { id: string; status: string } };
    expect(body.task.status).toBe('queued');

    const listed = await fetch(`${baseUrl}/v1/tasks`, { headers: auth });
    const list = (await listed.json()) as { tasks: Array<{ id: string }> };
    expect(list.tasks.some((t) => t.id === body.task.id)).toBe(true);
  });

  it('rejects a create without goal or repoPath', async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns task detail with log and 404 for unknown tasks', async () => {
    const detail = await fetch(`${baseUrl}/v1/tasks/nope`, { headers: auth });
    expect(detail.status).toBe(404);

    const created = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'g', repoPath: '/r' }),
    });
    const { task } = (await created.json()) as { task: { id: string } };
    const ok = await fetch(`${baseUrl}/v1/tasks/${task.id}`, { headers: auth });
    expect(ok.status).toBe(200);
    const taskDetail = (await ok.json()) as { log: Array<{ stream: string; text: string }> };
    expect(Array.isArray(taskDetail.log)).toBe(true); // log is an array, empty or with spawn errors
  });

  it('cancels queued tasks, 409 on running tasks, 404 on unknown', async () => {
    const created = await fetch(`${cancelBaseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'held task', repoPath: '/r' }),
    });
    const heldTask = (await created.json()) as { task: { id: string } };
    await waitForStatus(cancelBaseUrl, heldTask.task.id, 'running');

    const queued = await fetch(`${cancelBaseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'queued task', repoPath: '/r' }),
    });
    const queuedTask = (await queued.json()) as { task: { id: string } };

    const cancelled = await fetch(`${cancelBaseUrl}/v1/tasks/${queuedTask.task.id}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(cancelled.status).toBe(200);

    const conflict = await fetch(`${cancelBaseUrl}/v1/tasks/${heldTask.task.id}/cancel`, {
      method: 'POST',
      headers: auth,
    });
    expect(conflict.status).toBe(409);

    const missing = await fetch(`${cancelBaseUrl}/v1/tasks/ghost/cancel`, { method: 'POST', headers: auth });
    expect(missing.status).toBe(404);
  });

  it('resolves unknown gates with 404 (GateManager lands in Phase 8)', async () => {
    const res = await fetch(`${baseUrl}/v1/gates/ghost/resolve`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('orchestration and driver resolution', () => {
  async function create(body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as { task?: { driver?: string; orchestrate?: boolean } } };
  }

  it('defaults to direct when decompose is disabled and no driver is given', async () => {
    const { status, data } = await create({ goal: 'g', repoPath: '/r' });
    expect(status).toBe(201);
    expect(data.task?.orchestrate).toBe(false);
  });

  it('honors an explicit orchestrate flag', async () => {
    const { data } = await create({ goal: 'g', repoPath: '/r', orchestrate: true });
    expect(data.task?.orchestrate).toBe(true);
  });

  it('falls back to the first installed driver with a warning log', async () => {
    const { status, data } = await create({ goal: 'g', repoPath: '/r', driver: 'ghost' });
    expect(status).toBe(201);
    expect(data.task?.driver).toBe('opencode');

    const detail = await fetch(`${baseUrl}/v1/tasks/${(data.task as { id: string }).id}`, { headers: auth });
    const body = (await detail.json()) as { log: Array<{ text: string }> };
    expect(body.log.some((l) => l.text.includes('requested driver "ghost"'))).toBe(true);
  });

  it('rejects creates when no agent CLI is installed', async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'g', repoPath: '/r' }),
    });
    // main server has INSTALLED; simulate none via a dedicated server below
    expect(res.status).toBe(201);
    const noDrivers = createFraktoleServer({
      engine: daemon.engine,
      bus: daemon.bus,
      tokens: [TOKEN],
      drivers: [],
    });
    await new Promise<void>((resolve) => noDrivers.listen(0, '127.0.0.1', () => resolve()));
    const port = (noDrivers.address() as AddressInfo).port;
    const empty = await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'g', repoPath: '/r' }),
    });
    expect(empty.status).toBe(400);
    noDrivers.closeAllConnections();
    await new Promise<void>((resolve) => noDrivers.close(() => resolve()));
  });
});

describe('WebSocket', () => {
  it('rejects connections without a valid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}${WS_PATH}`);
    const closed = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(closed).toBe(4401);
  });

  it('streams events and backfills with get since', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}${WS_PATH}`, {
      headers: auth,
    });
    const received: EventEnvelope[] = [];
    const sawTaskCreated = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        received.push(JSON.parse(String(data)) as EventEnvelope);
        if (received.some((ev) => ev.kind === 'TaskCreated')) resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'streamed task', repoPath: '/r' }),
    });
    await res.json();
    await sawTaskCreated;

    ws.send(JSON.stringify({ type: 'get', since: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    const replay = received.filter((ev) => ev.seq >= 1);
    expect(replay.length).toBeGreaterThan(0);
    ws.close();
  });
});
