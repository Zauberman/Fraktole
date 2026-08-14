import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { RemoteBackend } from '../electron/remote/backend.js';
import { RemoteBridge } from '../electron/remote/bridge.js';
import { RemoteStore } from '../electron/remote/store.js';

// ————— test scaffolding —————

type FakeBackend = RemoteBackend & {
  sent: Array<{ agentId: string; kind: 'task' | 'note'; body: string }>;
  spawns: Array<{ cwd?: string; kind?: string }>;
};

function fakeBackend(): FakeBackend {
  const sent: FakeBackend['sent'] = [];
  const spawns: FakeBackend['spawns'] = [];
  return {
    serverName: 'Fraktole',
    version: '0.11.2',
    listSessions: async () => [
      { id: 's1', name: 'Session 1', project: '/tmp/proj', alive: true, tileCount: 2, updatedAt: 123 },
      { id: 's2', name: 'Session 2', project: '', alive: false, tileCount: 0, updatedAt: 99 },
    ],
    listTiles: async (sessionId) =>
      sessionId === 's1'
        ? [{ id: 'agent-1', name: 'agent-1', kind: 'agent', cwd: '/tmp/a', lines: 5, lastActiveAgoSec: 3 }]
        : [],
    readScrollback: async () => 'line1\nline2',
    liveTileOf: async (_sessionId, tileId) => (tileId === 'agent-1' ? 'live-1' : null),
    snapshot: async () => 'snapshot-tail',
    sendTask: async (args) => {
      sent.push(args);
      return { ok: true, messageId: 'm-1-1' };
    },
    listMessages: async () => [{ kind: 'note', from: 'agent-1', to: 'orchestrator', body: 'hi', ts: 9 }],
    spawnAgent: async (args) => {
      spawns.push(args);
      return { ok: true, agentId: 'agent-9' };
    },
    sent,
    spawns,
  };
}

class TestClient {
  private queue: unknown[] = [];
  private waiters: Array<{
    pred: (m: unknown) => boolean;
    resolve: (m: unknown) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly closed: Promise<void>;
  closeCode: number | null = null;
  closeReason = '';

  constructor(readonly ws: WebSocket) {
    ws.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeCode = code;
        this.closeReason = reason.toString();
        resolve();
      });
    });
    ws.on('message', (data, isBinary) => {
      const raw = isBinary
        ? Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8')
        : typeof data === 'string'
          ? data
          : Buffer.from(data as unknown as ArrayBuffer).toString('utf8');
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this.push(msg);
    });
  }

  private push(msg: unknown): void {
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w!.timer);
      w!.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  waitFor(pred: (m: unknown) => boolean, timeoutMs = 3000): Promise<unknown> {
    const idx = this.queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  async rpc(id: number, method: string, params?: unknown): Promise<unknown> {
    this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    return this.waitFor((m) => (m as { id?: number } | null)?.id === id);
  }

  send(frame: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  sendRaw(raw: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
  }
}

async function expectSilence(client: TestClient, pred: (m: unknown) => boolean, ms = 250): Promise<void> {
  try {
    await client.waitFor(pred, ms);
  } catch {
    return;
  }
  throw new Error('expected no message but one arrived');
}

interface TestEnv {
  bridge: RemoteBridge;
  store: RemoteStore;
  backend: ReturnType<typeof fakeBackend>;
  port: number;
  dir: string;
}

async function startBridge(overrides: {
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  rateLimit?: number;
  maxConnections?: number;
} = {}): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'frakt-bridge-'));
  const store = new RemoteStore(join(dir, 'remote'));
  const backend = fakeBackend();
  const bridge = new RemoteBridge({
    port: 0,
    certDir: join(dir, 'cert'),
    store,
    backend,
    logger: () => undefined,
    ...overrides,
  });
  await bridge.start();
  return { bridge, store, backend, port: bridge.boundPort, dir };
}

async function connect(port: number): Promise<TestClient> {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new TestClient(ws);
}

async function doPair(env: TestEnv, code?: string, deviceName = 'Pixel 8'): Promise<{ reply: unknown; client: TestClient }> {
  const client = await connect(env.port);
  client.send({ type: 'pair', code: code ?? env.bridge.pairingCode?.code ?? '', deviceName });
  const reply = await client.waitFor((m) => (m as { type?: string })?.type === 'pair-ok' || (m as { type?: string })?.type === 'pair-fail');
  await client.closed;
  return { reply, client };
}

async function doAuth(env: TestEnv, token: string): Promise<{ reply: unknown; client: TestClient }> {
  const client = await connect(env.port);
  client.send({ type: 'auth', token });
  const reply = await client.waitFor((m) => (m as { type?: string })?.type === 'auth-ok' || (m as { type?: string })?.type === 'auth-fail');
  return { reply, client };
}

let envs: TestEnv[] = [];
async function env(): Promise<TestEnv> {
  const e = await startBridge();
  envs.push(e);
  return e;
}

afterEach(async () => {
  for (const e of envs) {
    e.bridge.stop();
    await rm(e.dir, { recursive: true, force: true }).catch(() => undefined);
  }
  envs = [];
});

// ————— pairing (§2) —————

describe('pairing', () => {
  it('pairs with a valid code: token, deviceId and fingerprint', async () => {
    const e = await env();
    const code = e.bridge.pairingCode!.code;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const { reply } = await doPair(e, code);
    const pairOk = reply as { type: string; token: string; deviceId: string; serverFingerprint: string };
    expect(pairOk.type).toBe('pair-ok');
    expect(pairOk.token).toMatch(/^[0-9a-f]{64}$/);
    expect(pairOk.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pairOk.serverFingerprint).toBe(e.bridge.fingerprint256);

    // the device is persisted, hashed only
    const state = await e.store.get();
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]!.name).toBe('Pixel 8');
    expect(state.devices[0]!.tokenHash).not.toBe(pairOk.token);
  });

  it('rejects a wrong code with pair-fail and closes', async () => {
    const e = await env();
    const { reply } = await doPair(e, 'AAAA-AAAA');
    expect(reply).toMatchObject({ type: 'pair-fail', reason: 'invalid-code' });
  });

  it('rejects a malformed code', async () => {
    const e = await env();
    const { reply } = await doPair(e, 'nope');
    expect(reply).toMatchObject({ type: 'pair-fail', reason: 'invalid-code' });
  });

  it('a pairing code is single use', async () => {
    const e = await env();
    const code = e.bridge.pairingCode!.code;
    await doPair(e, code);
    const second = await doPair(e, code);
    expect(second.reply).toMatchObject({ type: 'pair-fail', reason: 'invalid-code' });
  });

  it('rotates the code after a successful pair', async () => {
    const e = await env();
    const code = e.bridge.pairingCode!.code;
    await doPair(e, code);
    expect(e.bridge.pairingCode!.code).not.toBe(code);
  });

  it('reports expired codes once past the TTL', async () => {
    const e = await startBridge();
    envs.push(e);
    const code = e.bridge.pairingCode!.code;
    // simulate the code aging out
    (e.bridge as unknown as { codes: { current: { expiresAt: number } } }).codes!.current!.expiresAt = Date.now() - 1;
    const { reply } = await doPair(e, code);
    expect(reply).toMatchObject({ type: 'pair-fail', reason: 'expired' });
  });
});

// ————— auth (§3) —————

describe('auth', () => {
  it('authenticates with the paired token and gets server info', async () => {
    const e = await env();
    const { reply: pairReply } = await doPair(e);
    const token = (pairReply as { token: string }).token;

    const { reply, client } = await doAuth(e, token);
    expect(reply).toMatchObject({ type: 'auth-ok', serverName: 'Fraktole', version: '0.11.2' });
    const authOk = reply as { deviceId: string };
    expect(authOk.deviceId).toBe((pairReply as { deviceId: string }).deviceId);

    // lastSeen was updated
    const state = await e.store.get();
    expect(state.devices[0]!.lastSeen).toBeGreaterThan(state.devices[0]!.createdAt);
    client.ws.close();
  });

  it('rejects a bad token with auth-fail and closes', async () => {
    const e = await env();
    const { reply, client } = await doAuth(e, 'f'.repeat(64));
    expect(reply).toMatchObject({ type: 'auth-fail', reason: 'bad-token' });
    await client.closed;
  });

  it('rejects a non-hex token', async () => {
    const e = await env();
    const { reply } = await doAuth(e, 'z'.repeat(64));
    expect(reply).toMatchObject({ type: 'auth-fail', reason: 'bad-token' });
  });

  it('rejects a revoked device token', async () => {
    const e = await env();
    const { reply: pairReply } = await doPair(e);
    const token = (pairReply as { token: string }).token;
    const deviceId = (pairReply as { deviceId: string }).deviceId;

    await e.store.revokeDevice(deviceId);
    e.bridge.revokeDevice(deviceId);

    const { reply, client } = await doAuth(e, token);
    expect(reply).toMatchObject({ type: 'auth-fail', reason: 'bad-token' });
    await client.closed;
  });

  it('closes a connection that sends nothing within the auth timeout', async () => {
    const e = await startBridge({ authTimeoutMs: 150 });
    envs.push(e);
    const client = await connect(e.port);
    await client.closed;
    expect(client.closeCode).toBe(1008);
  });

  it('answers RPC-as-first-frame with -32000 then closes', async () => {
    const e = await env();
    const client = await connect(e.port);
    client.sendRaw(JSON.stringify({ id: 1, method: 'health' }));
    const reply = await client.waitFor((m) => (m as { id?: number })?.id === 1);
    expect(reply).toMatchObject({ error: { code: -32000 } });
    await client.closed;
  });

  it('closes on a malformed first frame', async () => {
    const e = await env();
    const client = await connect(e.port);
    client.sendRaw('not json');
    await client.closed;
    expect(client.closeCode).toBe(1008);
  });
});

// ————— eviction / connections —————

describe('connection policy', () => {
  it('evicts the old control connection when a device reconnects', async () => {
    const e = await env();
    const { reply: pairReply } = await doPair(e);
    const token = (pairReply as { token: string }).token;

    const first = await doAuth(e, token);
    const second = await doAuth(e, token);
    expect(first.reply).toMatchObject({ type: 'auth-ok' });
    expect(second.reply).toMatchObject({ type: 'auth-ok' });
    await first.client.closed;
    expect(first.client.closeCode).toBe(1008);
    second.client.ws.close();
  });

  it('allows different devices concurrently', async () => {
    const e = await env();
    const t1 = (await doPair(e, undefined, 'Pixel')).reply as { token: string };
    const t2 = (await doPair(e)).reply as { token: string };
    expect(t2.token).not.toBe(t1.token);
    const a1 = await doAuth(e, t1.token);
    const a2 = await doAuth(e, t2.token);
    expect(a1.reply).toMatchObject({ type: 'auth-ok' });
    expect(a2.reply).toMatchObject({ type: 'auth-ok' });
    a1.client.ws.close();
    a2.client.ws.close();
  });

  it('rejects a 5th concurrent connection', async () => {
    const e = await startBridge({ authTimeoutMs: 5000 });
    envs.push(e);
    const clients = await Promise.all([connect(e.port), connect(e.port), connect(e.port), connect(e.port)]);
    const fifth = await connect(e.port);
    await fifth.closed;
    expect(fifth.closeCode).toBe(1008);
    for (const c of clients) c.ws.close();
  });

  it('closes a connection that exceeds 120 msg/s', async () => {
    const e = await env();
    const token = (await doPair(e)).reply as { token: string };
    const { client } = await doAuth(e, token.token);
    for (let i = 0; i < 150; i += 1) client.send({ type: 'pong' });
    await client.closed;
    expect(client.closeCode).toBe(1008);
  });

  it('closes a connection that sends an oversized frame', async () => {
    const e = await env();
    const token = (await doPair(e)).reply as { token: string };
    const { client } = await doAuth(e, token.token);
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(Buffer.alloc(2 * 1024 * 1024));
    await client.closed;
    expect(client.closeCode).toBe(1009);
  });
});

// ————— JSON-RPC (§4) —————

describe('JSON-RPC', () => {
  async function authed(env: TestEnv): Promise<{ client: TestClient }> {
    const token = (await doPair(env)).reply as { token: string };
    const { client } = await doAuth(env, token.token);
    return { client };
  }

  it('round-trips sessions.list', async () => {
    const e = await env();
    const { client } = await authed(e);
    const reply = await client.rpc(1, 'sessions.list');
    expect((reply as { id: number }).id).toBe(1);
    const result = (reply as { result: Array<Record<string, unknown>> }).result;
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 's1',
      name: 'Session 1',
      project: '/tmp/proj',
      alive: true,
      tileCount: 2,
    });
    client.ws.close();
  });

  it('round-trips tiles.list and its tile.list alias', async () => {
    const e = await env();
    const { client } = await authed(e);
    const reply = await client.rpc(2, 'tiles.list', { sessionId: 's1' });
    expect(reply).toMatchObject({
      id: 2,
      result: [{ id: 'agent-1', name: 'agent-1', kind: 'agent', cwd: '/tmp/a', lines: 5 }],
    });
    const alias = await client.rpc(3, 'tile.list', { sessionId: 's1' });
    expect(alias).toMatchObject({ result: [{ id: 'agent-1' }] });
    client.ws.close();
  });

  it('rejects tiles.list without sessionId', async () => {
    const e = await env();
    const { client } = await authed(e);
    const reply = await client.rpc(4, 'tiles.list');
    expect(reply).toMatchObject({ error: { code: -32000 } });
    client.ws.close();
  });

  it('subscribes to a tile, streams output and snapshots', async () => {
    const e = await env();
    const { client } = await authed(e);

    const sub = await client.rpc(5, 'tile.subscribe', { sessionId: 's1', tileId: 'agent-1' });
    expect(sub).toMatchObject({ id: 5, result: { ok: true } });
    const snapshot = await client.waitFor((m) => (m as { type?: string })?.type === 'tile.snapshot');
    expect(snapshot).toMatchObject({ type: 'tile.snapshot', params: { tileId: 'agent-1', data: 'snapshot-tail' } });

    // live output for the subscribed tile arrives
    e.bridge.publish({ type: 'tile.output', sessionId: 's1', tileId: 'live-1', data: 'hello', ts: 42 });
    const output = await client.waitFor((m) => (m as { type?: string })?.type === 'tile.output');
    expect(output).toMatchObject({ type: 'tile.output', params: { tileId: 'live-1', data: 'hello', ts: 42 } });

    // tile.state for the subscribed tile arrives too
    e.bridge.publish({ type: 'tile.state', sessionId: 's1', tileId: 'live-1', alive: false, lines: 3 });
    const state = await client.waitFor((m) => (m as { type?: string })?.type === 'tile.state');
    expect(state).toMatchObject({ type: 'tile.state', params: { tileId: 'live-1', alive: false, lines: 3 } });

    client.ws.close();
  });

  it('scopes tile events per session', async () => {
    const e = await env();
    const { client } = await authed(e);
    await client.rpc(6, 'tile.subscribe', { sessionId: 's1', tileId: 'agent-1' });
    await client.waitFor((m) => (m as { type?: string })?.type === 'tile.snapshot');

    // same live tile id but a different session: must NOT arrive
    e.bridge.publish({ type: 'tile.output', sessionId: 's2', tileId: 'live-1', data: 'wrong session', ts: 1 });
    await expectSilence(client, (m) => (m as { type?: string })?.type === 'tile.output');

    // and after unsubscribe nothing arrives either
    await client.rpc(7, 'tile.unsubscribe', { tileId: 'agent-1' });
    e.bridge.publish({ type: 'tile.output', sessionId: 's1', tileId: 'live-1', data: 'after unsub', ts: 2 });
    await expectSilence(client, (m) => (m as { type?: string })?.type === 'tile.output');
    client.ws.close();
  });

  it('streams session.state and message.new to all authenticated connections', async () => {
    const e = await env();
    const a = await authed(e);
    const b = await authed(e);

    e.bridge.publish({ type: 'session.state', sessionId: 's1', alive: false });
    e.bridge.publish({
      type: 'message.new',
      sessionId: 's1',
      msg: { kind: 'note', from: 'agent-1', to: 'orchestrator', body: 'done', ts: 77 },
    });

    for (const c of [a.client, b.client]) {
      const state = await c.waitFor((m) => (m as { type?: string })?.type === 'session.state');
      expect(state).toMatchObject({ type: 'session.state', params: { sessionId: 's1', alive: false } });
      const msg = await c.waitFor((m) => (m as { type?: string })?.type === 'message.new');
      expect(msg).toMatchObject({ type: 'message.new', params: { kind: 'note', from: 'agent-1', body: 'done', ts: 77 } });
    }
    a.client.ws.close();
    b.client.ws.close();
  });

  it('round-trips scrollback.read, task.send, messages.list, agent.spawn, health', async () => {
    const e = await env();
    const { client } = await authed(e);

    const scroll = await client.rpc(8, 'scrollback.read', { tileId: 'agent-1', tail: 2 });
    expect(scroll).toMatchObject({ id: 8, result: { data: 'line1\nline2' } });

    const task = await client.rpc(9, 'task.send', { agentId: 'agent-1', kind: 'task', body: 'go' });
    expect(task).toMatchObject({ id: 9, result: { ok: true, messageId: 'm-1-1' } });
    expect(e.backend.sent).toEqual([{ agentId: 'agent-1', kind: 'task', body: 'go' }]);

    const msgs = await client.rpc(10, 'messages.list', { limit: 5 });
    expect(msgs).toMatchObject({ id: 10, result: [{ kind: 'note', from: 'agent-1', to: 'orchestrator', body: 'hi', ts: 9 }] });

    const spawn = await client.rpc(11, 'agent.spawn', { cwd: '/tmp/z', kind: 'opencode' });
    expect(spawn).toMatchObject({ id: 11, result: { ok: true, agentId: 'agent-9' } });
    expect(e.backend.spawns).toEqual([{ cwd: '/tmp/z', kind: 'opencode' }]);

    const health = await client.rpc(12, 'health');
    expect(health).toMatchObject({ id: 12, result: { ok: true } });
    expect((health as { result: { ts: number } }).result.ts).toBeGreaterThan(0);
    client.ws.close();
  });

  it('rejects task.send without required params', async () => {
    const e = await env();
    const { client } = await authed(e);
    const reply = await client.rpc(13, 'task.send', { agentId: 'agent-1' });
    expect(reply).toMatchObject({ error: { code: -32000 } });
    client.ws.close();
  });

  it('answers unknown methods with -32601', async () => {
    const e = await env();
    const { client } = await authed(e);
    const reply = await client.rpc(14, 'no.such.method');
    expect(reply).toMatchObject({ error: { code: -32601 } });
    client.ws.close();
  });

  it('answers malformed JSON with -32700', async () => {
    const e = await env();
    const { client } = await authed(e);
    client.sendRaw('{oops');
    const reply = await client.waitFor((m) => (m as { error?: { code: number } })?.error?.code === -32700);
    expect(reply).toMatchObject({ error: { code: -32700 } });
    client.ws.close();
  });
});

// ————— events (§5) —————

describe('server events', () => {
  it('pings every pingIntervalMs', async () => {
    const e = await startBridge({ pingIntervalMs: 100 });
    envs.push(e);
    const token = (await doPair(e)).reply as { token: string };
    const { client } = await doAuth(e, token.token);
    const ping = await client.waitFor((m) => (m as { type?: string })?.type === 'ping');
    expect(ping).toMatchObject({ type: 'ping' });
    expect(typeof (ping as { params: { ts: number } }).params.ts).toBe('number');
    client.ws.close();
  });
});

// ————— start failures —————

describe('start failures', () => {
  it('rejects with EADDRINUSE when the port is already taken (surfaced as status.error)', async () => {
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const dir = await mkdtemp(join(tmpdir(), 'frakt-bridge-busy-'));
      const store = new RemoteStore(join(dir, 'remote'));
      const bridge = new RemoteBridge({
        port,
        certDir: join(dir, 'cert'),
        store,
        backend: fakeBackend(),
        logger: () => undefined,
      });
      await expect(bridge.start()).rejects.toThrow(/EADDRINUSE/i);
      expect(bridge.listening).toBe(false);
      bridge.stop();
      await rm(dir, { recursive: true, force: true });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
