import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import {
  ROUTES,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type CreateTaskBody,
  type EventEnvelope,
  type ResolveGateBody,
  type TlsConfig,
  type WsClientMessage,
} from '@fraktole/core';
import { WebSocketServer } from 'ws';
import { checkAuth, type AuthContext } from './auth.js';
import type { EventBus } from './event-bus.js';
import type { PairingStore } from './pairing.js';
import type { DiscoveredDriver } from './drivers/discovery.js';
import { type RepoRegistry } from './repos.js';
import { loadTlsOptions } from './tls.js';
import { NotCancellableError, TaskNotFoundError, type TaskEngine } from './task-engine.js';

export interface ServerDeps {
  engine: TaskEngine;
  bus: EventBus;
  tokens: string[];
  pairing?: PairingStore;
  tls?: TlsConfig;
  /** availability of agent CLIs, refreshed at startup */
  drivers?: DiscoveredDriver[];
  /** default for `orchestrate` when the create body omits it */
  decomposeDefault?: boolean;
  repos?: RepoRegistry;
}

type ServerLike = Server | HttpsServer;

export function createFraktoleServer(deps: ServerDeps): ServerLike {
  const authCtx: AuthContext = {
    tokens: deps.tokens,
    deviceTokens: deps.pairing?.list().map((d) => d.token),
  };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, deps, authCtx);
  };
  const server = deps.tls
    ? createHttpsServer(loadTlsOptions(deps.tls), handler)
    : createHttpServer(handler);
  const wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on('connection', (ws, req) => {
    if (!checkAuth(req.headers.authorization, authCtx)) {
      ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const send = (data: string): void => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    };
    const unsub = deps.bus.subscribe((ev) => send(JSON.stringify(ev)));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as WsClientMessage;
        if (msg.type === 'get') {
          for (const ev of deps.bus.replaySince(msg.since)) send(JSON.stringify(ev));
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.on('close', unsub);
  });
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  authCtx: AuthContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  // POST /v1/devices/pair is public: the one-time code is the credential.
  const isPublicPair = method === 'POST' && path === '/v1/devices/pair';
  if (!isPublicPair && !checkAuth(req.headers.authorization, authCtx)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  try {
    if (method === 'POST' && path === ROUTES.createTask) {
      const body = await readJson<CreateTaskBody>(req);
      if (typeof body?.goal !== 'string' || body.goal.trim() === '' || typeof body.repoPath !== 'string') {
        sendJson(res, 400, { error: 'goal and repoPath (strings) are required' });
        return;
      }
      const requested = body.driver ?? 'opencode';
      const installed = (deps.drivers ?? []).filter((d) => d.installed);
      if (installed.length === 0) {
        sendJson(res, 400, {
          error: 'no agent CLIs found on PATH (tried opencode, claude, codex, aider and configured plugins)',
        });
        return;
      }
      let driver = requested;
      if (!installed.some((d) => d.id === driver)) {
        driver = installed[0]!.id;
      }
      const task = deps.engine.createTask({
        goal: body.goal,
        repoPath: body.repoPath,
        baseBranch: body.baseBranch ?? 'main',
        driver,
        // explicit flag wins; otherwise "no driver given" + decompose config
        orchestrate: body.orchestrate ?? (body.driver === undefined && (deps.decomposeDefault ?? true)),
      });
      if (driver !== requested) {
        deps.bus.publish('LogChunk', task.id, {
          taskId: task.id,
          stream: 'stderr',
          text: `[fraktole] requested driver "${requested}" not found on PATH; running with "${driver}"\n`,
        });
      }
      sendJson(res, 201, { task });
      return;
    }
    if (method === 'GET' && path === '/v1/drivers') {
      sendJson(res, 200, { drivers: deps.drivers ?? [] });
      return;
    }
    if (method === 'GET' && path === ROUTES.repos) {
      if (!deps.repos) return sendJson(res, 501, { error: 'repos not configured' });
      sendJson(res, 200, { repos: deps.repos.list() });
      return;
    }
    if (method === 'POST' && path === ROUTES.repos) {
      if (!deps.repos) return sendJson(res, 501, { error: 'repos not configured' });
      const body = await readJson<{ path?: string }>(req);
      if (typeof body?.path !== 'string' || body.path.trim() === '') {
        sendJson(res, 400, { error: 'path (string) is required' });
        return;
      }
      const repo = await deps.repos.add(body.path);
      sendJson(res, 201, { repo });
      return;
    }
    if (method === 'DELETE' && path === ROUTES.repos) {
      if (!deps.repos) return sendJson(res, 501, { error: 'repos not configured' });
      const body = await readJson<{ path?: string }>(req);
      if (typeof body?.path !== 'string') {
        sendJson(res, 400, { error: 'path (string) is required' });
        return;
      }
      const removed = await deps.repos.remove(body.path);
      if (!removed) return sendJson(res, 404, { error: `repo not registered: ${body.path}` });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && path === ROUTES.listTasks) {
      sendJson(res, 200, { tasks: deps.engine.listTasks() });
      return;
    }
    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (method === 'GET' && taskMatch) {
      const task = deps.engine.getTask(taskMatch[1]!);
      if (!task) {
        sendJson(res, 404, { error: `task not found: ${taskMatch[1]}` });
        return;
      }
      sendJson(res, 200, { task, log: recentLog(deps.bus, task.id) });
      return;
    }
    const cancelMatch = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancelMatch) {
      try {
        const task = deps.engine.getTask(cancelMatch[1]!);
        if (!task) throw new TaskNotFoundError(cancelMatch[1]!);
        deps.engine.cancelTask(task.id);
        sendJson(res, 200, { task });
      } catch (err) {
        if (err instanceof TaskNotFoundError) sendJson(res, 404, { error: err.message });
        else if (err instanceof NotCancellableError) sendJson(res, 409, { error: err.message });
        else throw err;
      }
      return;
    }
    const gateMatch = /^\/v1\/gates\/([^/]+)\/resolve$/.exec(path);
    if (method === 'POST' && gateMatch) {
      const body = await readJson<ResolveGateBody>(req);
      if (body?.decision !== 'approve' && body?.decision !== 'deny') {
        sendJson(res, 400, { error: 'decision must be "approve" or "deny"' });
        return;
      }
      try {
        deps.engine.resolveGate(gateMatch[1]!, body.decision);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof TaskNotFoundError) sendJson(res, 404, { error: err.message });
        else throw err;
      }
      return;
    }
    if (method === 'POST' && path === '/v1/devices/codes') {
      if (!deps.pairing) return sendJson(res, 501, { error: 'pairing not configured' });
      sendJson(res, 200, { code: deps.pairing.createCode(), ttlMs: 10 * 60 * 1000 });
      return;
    }
    if (method === 'POST' && path === '/v1/devices/pair') {
      if (!deps.pairing) return sendJson(res, 501, { error: 'pairing not configured' });
      const body = await readJson<{ code?: string }>(req);
      const device = typeof body?.code === 'string' ? deps.pairing.exchangeCode(body.code) : undefined;
      if (!device) return sendJson(res, 401, { error: 'invalid or expired pairing code' });
      authCtx.deviceTokens = deps.pairing.list().map((d) => d.token);
      sendJson(res, 201, { device });
      return;
    }
    if (method === 'GET' && path === '/v1/devices') {
      if (!deps.pairing) return sendJson(res, 501, { error: 'pairing not configured' });
      sendJson(res, 200, { devices: deps.pairing.list() });
      return;
    }
    const revokeMatch = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && revokeMatch) {
      if (!deps.pairing) return sendJson(res, 501, { error: 'pairing not configured' });
      const removed = deps.pairing.revoke(revokeMatch[1]!);
      if (!removed) return sendJson(res, 404, { error: `device not found: ${revokeMatch[1]}` });
      authCtx.deviceTokens = deps.pairing.list().map((d) => d.token);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: `no route: ${method} ${path}` });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function recentLog(
  bus: EventBus,
  taskId: string,
): Array<{ stream: 'stdout' | 'stderr'; text: string; ts: string }> {
  return bus
    .replaySince(-1)
    .filter(isLogChunk)
    .filter((ev) => ev.taskId === taskId)
    .slice(-200)
    .map((ev) => ({
      stream: ev.payload.stream,
      text: ev.payload.text,
      ts: ev.ts,
    }));
}

function isLogChunk(ev: EventEnvelope): ev is Extract<EventEnvelope, { kind: 'LogChunk' }> {
  return ev.kind === 'LogChunk';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
