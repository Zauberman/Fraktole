import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { RemoteBackend, RemoteEvent } from './backend.js';
import { loadOrCreateCert } from './cert.js';
import { PairingCodes, type PairingCode } from './pairing.js';
import { RateLimiter } from './rate-limit.js';
import { hashToken, RemoteStore, type RemoteDevice } from './store.js';

export const DEFAULT_REMOTE_PORT = 8833;
const MAX_CONNECTIONS = 4;
const MAX_PAYLOAD = 1024 * 1024; // 1 MiB per frame
const RATE_LIMIT = 120; // messages per second per connection
const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 15_000;

export interface RemoteBridgeOpts {
  port?: number;
  host?: string;
  backend: RemoteBackend;
  store: RemoteStore;
  certDir: string;
  maxConnections?: number;
  maxPayload?: number;
  rateLimit?: number;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Fired when anything the Remote tab shows changes (devices, pairing
   *  code rotation, connection state). */
  onStatusChange?: () => void;
  logger?: (line: string) => void;
}

interface Conn {
  socket: WebSocket;
  device: { deviceId: string; name: string } | null;
  limiter: RateLimiter;
  authTimer: NodeJS.Timeout;
  pingTimer: NodeJS.Timeout | null;
  /** clientFacingTileId → { sessionId, liveTileId } */
  subs: Map<string, { sessionId: string; liveTileId: string | null }>;
}

const log = (opts: RemoteBridgeOpts, line: string): void => (opts.logger ?? console.log)(`[remote] ${line}`);

/** LAN IPv4 addresses, for the Remote tab's connect hints. */
export function lanIps(): string[] {
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out.sort();
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function jsonError(id: unknown, code: number, message: string): unknown {
  return { id: typeof id === 'number' || typeof id === 'string' ? id : null, error: { code, message } };
}

/**
 * The Fraktole Remote WSS bridge (docs/remote-protocol.md):
 *
 *  - TLS self-signed cert persisted under userData/remote/ (TOFU pairing)
 *  - pairing: one-time XXXX-XXXX code, 5-min TTL, constant-time compare
 *  - auth: sha256(token) vs the hashed device store; one control connection
 *    per device (a new connection evicts the old)
 *  - JSON-RPC (§4) + event streaming (§5) with ping every 15 s
 *  - limits: max 4 concurrent connections, 120 msg/s per connection,
 *    1 MiB frames
 */
export class RemoteBridge {
  private readonly port: number;
  private readonly host: string;
  private readonly backend: RemoteBackend;
  private readonly store: RemoteStore;
  private readonly certDir: string;
  private readonly maxConnections: number;
  private readonly maxPayload: number;
  private readonly rateLimit: number;
  private readonly authTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: (line: string) => void;

  private httpsServer: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  /** deviceId → control connection (one per device). */
  private connsByDevice = new Map<string, Conn>();
  private codes: PairingCodes | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private fingerprint: string | null = null;
  private started = false;

  constructor(private readonly opts: RemoteBridgeOpts) {
    this.port = opts.port ?? DEFAULT_REMOTE_PORT;
    this.host = opts.host ?? '0.0.0.0';
    this.backend = opts.backend;
    this.store = opts.store;
    this.certDir = opts.certDir;
    this.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.maxPayload = opts.maxPayload ?? MAX_PAYLOAD;
    this.rateLimit = opts.rateLimit ?? RATE_LIMIT;
    this.authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? console.log;
  }

  get listening(): boolean {
    return this.started && this.httpsServer !== null;
  }

  get boundPort(): number {
    const addr = this.httpsServer?.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  get fingerprint256(): string | null {
    return this.fingerprint;
  }

  get pairingCode(): PairingCode | null {
    return this.codes ? this.codes.currentOrNew() : null;
  }

  /** Live devices from the store, tagged with their connection state. */
  async devices(): Promise<Array<RemoteDevice & { connected: boolean }>> {
    const state = await this.store.get();
    return state.devices.map((d) => ({ ...d, connected: this.connsByDevice.has(d.deviceId) }));
  }

  /** Binds the WSS server (idempotent); no-op when already running. */
  async start(): Promise<void> {
    if (this.started) return;
    const cert = await loadOrCreateCert(this.certDir);
    this.fingerprint = cert.fingerprint256;
    const server = createHttpsServer({ cert: cert.certPem, key: cert.keyPem });
    // a listen failure (EADDRINUSE) must reject start() cleanly — never an
    // unhandled 'error' event that would take the whole app down. The
    // handler stays attached for the server's lifetime and just logs once
    // the bridge is up.
    let listenError: ((err: Error) => void) | null = null;
    const onServerError = (err: Error): void => {
      if (listenError) {
        listenError(err);
        listenError = null;
      } else {
        log(this.opts, `server error: ${err.message}`);
      }
    };
    server.on('error', onServerError);
    const wss = new WebSocketServer({
      server,
      maxPayload: this.maxPayload,
      perMessageDeflate: false,
    });
    // ws re-emits server errors on the WSS — silence that path so a bind
    // failure can never crash the process
    wss.on('error', () => undefined);
    this.httpsServer = server;
    this.wss = wss;
    this.codes = new PairingCodes({ now: this.now });
    wss.on('connection', (socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      listenError = reject;
      server.listen(this.port, this.host, () => {
        listenError = null;
        resolve();
      });
    });
    this.started = true;
    log(this.opts, `listening on ${this.host}:${this.boundPort} (fingerprint ${this.fingerprint})`);
    this.scheduleRotate();
  }

  /** Stops the server and closes every connection. */
  stop(): void {
    if (this.rotateTimer) {
      clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
    for (const conn of [...this.conns]) this.closeConn(conn, 1001, 'bridge stopped');
    this.wss?.close();
    this.wss = null;
    this.httpsServer?.close();
    this.httpsServer = null;
    this.started = false;
    this.codes = null;
  }

  /** Rotates the pairing code and reports the new status. */
  rotatePairingCode(): PairingCode | null {
    const code = this.codes?.rotate() ?? null;
    this.opts.logger?.(`[remote] pairing code rotated`);
    this.opts.onStatusChange?.();
    return code;
  }

  /** Invalidates a device server-side: closes its live connection and makes
   *  its token unusable (the store entry is removed by the caller). */
  revokeDevice(deviceId: string): void {
    const conn = this.connsByDevice.get(deviceId);
    if (conn) this.closeConn(conn, 1008, 'device revoked');
  }

  /** Desktop → connected phones: tile output/state, session state, messages. */
  publish(ev: RemoteEvent): void {
    for (const conn of [...this.conns]) {
      if (!conn.device) continue;
      switch (ev.type) {
        case 'tile.output':
          for (const sub of conn.subs.values()) {
            if (sub.sessionId === ev.sessionId && sub.liveTileId === ev.tileId) {
              sendJson(conn.socket, { type: 'tile.output', params: { tileId: ev.tileId, data: ev.data, ts: ev.ts } });
            }
          }
          break;
        case 'tile.state':
          for (const sub of conn.subs.values()) {
            if (sub.sessionId === ev.sessionId && sub.liveTileId === ev.tileId) {
              sendJson(conn.socket, {
                type: 'tile.state',
                params: { tileId: ev.tileId, alive: ev.alive, lines: ev.lines },
              });
            }
          }
          break;
        case 'session.state':
          sendJson(conn.socket, { type: 'session.state', params: { sessionId: ev.sessionId, alive: ev.alive } });
          break;
        case 'message.new':
          sendJson(conn.socket, { type: 'message.new', params: { ...ev.msg, ts: ev.msg.ts } });
          break;
      }
    }
  }

  // ————— connection lifecycle —————

  private onConnection(socket: WebSocket): void {
    if (this.conns.size >= this.maxConnections) {
      socket.close(1008, 'too many connections');
      return;
    }
    const conn: Conn = {
      socket,
      device: null,
      limiter: new RateLimiter(this.rateLimit, 1000, this.now),
      authTimer: setTimeout(() => this.closeConn(conn, 1008, 'auth timeout'), this.authTimeoutMs),
      pingTimer: null,
      subs: new Map(),
    };
    conn.authTimer.unref();
    this.conns.add(conn);
    socket.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    socket.on('close', () => this.onClose(conn));
    socket.on('error', () => this.onClose(conn));
  }

  private onClose(conn: Conn): void {
    this.closeConn(conn, 1000, 'bye');
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    if (conn.device && this.connsByDevice.get(conn.device.deviceId) === conn) {
      this.connsByDevice.delete(conn.device.deviceId);
    }
    if (conn.authTimer) clearTimeout(conn.authTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    try {
      conn.socket.close(code, reason);
    } catch {
      // already closed
    }
    this.opts.onStatusChange?.();
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (!conn.limiter.allow()) {
      this.closeConn(conn, 1008, 'rate limit exceeded');
      return;
    }
    const raw = isBinary
      ? Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8')
      : typeof data === 'string'
        ? data
        : Buffer.from(data as unknown as ArrayBuffer).toString('utf8');
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      if (conn.device) {
        sendJson(conn.socket, jsonError(null, -32700, 'parse error'));
      } else {
        this.closeConn(conn, 1008, 'malformed json');
      }
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      if (conn.device) {
        sendJson(conn.socket, jsonError(null, -32700, 'parse error'));
      } else {
        this.closeConn(conn, 1008, 'malformed frame');
      }
      return;
    }
    const msg = frame as Record<string, unknown>;
    if (!conn.device) {
      void this.handleFirstFrame(conn, msg);
      return;
    }
    if (msg.type === 'pong') return; // heartbeat acknowledgement
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleRpc(conn, msg.id, msg.method, msg.params);
    }
  }

  /** The first frame on a socket must be pair or auth (§2/§3). */
  private async handleFirstFrame(conn: Conn, msg: Record<string, unknown>): Promise<void> {
    clearTimeout(conn.authTimer);
    if (msg.type === 'pair') {
      await this.handlePair(conn, msg);
      return;
    }
    if (msg.type === 'auth') {
      await this.handleAuth(conn, msg);
      return;
    }
    if (typeof msg.method === 'string') {
      // RPC before auth: answer -32000 then close
      sendJson(conn.socket, jsonError(msg.id, -32000, 'not authenticated'));
    }
    this.closeConn(conn, 1008, 'expected pair or auth');
  }

  private async handlePair(conn: Conn, msg: Record<string, unknown>): Promise<void> {
    const code = typeof msg.code === 'string' ? msg.code : '';
    const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Device';
    const codes = this.codes;
    if (!codes) {
      this.closeConn(conn, 1008, 'bridge not ready');
      return;
    }
    const verdict = codes.check(code);
    if (verdict === 'expired') {
      sendJson(conn.socket, { type: 'pair-fail', reason: 'expired' });
      this.closeConn(conn, 1008, 'expired');
      return;
    }
    if (verdict !== 'ok') {
      sendJson(conn.socket, { type: 'pair-fail', reason: 'invalid-code' });
      this.closeConn(conn, 1008, 'invalid code');
      return;
    }
    const { device, token } = await this.store.addDevice(deviceName);
    const fingerprint = this.fingerprint;
    sendJson(conn.socket, {
      type: 'pair-ok',
      token,
      deviceId: device.deviceId,
      serverFingerprint: fingerprint ?? '',
    });
    log(this.opts, `paired device ${device.name} (${device.deviceId})`);
    // the code is consumed — mint a fresh one for the next pairing
    this.codes?.rotate();
    this.opts.onStatusChange?.();
    // §2: the phone reconnects with the token over the pinned cert
    this.closeConn(conn, 1000, 'paired');
  }

  private async handleAuth(conn: Conn, msg: Record<string, unknown>): Promise<void> {
    const token = typeof msg.token === 'string' ? msg.token : '';
    if (!/^[0-9a-f]{64}$/.test(token)) {
      sendJson(conn.socket, { type: 'auth-fail', reason: 'bad-token' });
      this.closeConn(conn, 1008, 'bad token');
      return;
    }
    const hash = hashToken(token);
    const state = await this.store.get();
    const device = state.devices.find((d) => d.tokenHash === hash);
    if (!device) {
      sendJson(conn.socket, { type: 'auth-fail', reason: 'bad-token' });
      this.closeConn(conn, 1008, 'bad token');
      return;
    }
    // one control connection per device — evict any older one
    const existing = this.connsByDevice.get(device.deviceId);
    if (existing && existing !== conn) {
      log(this.opts, `device ${device.name} reconnecting — evicting old connection`);
      this.closeConn(existing, 1008, 'replaced by new connection');
    }
    conn.device = { deviceId: device.deviceId, name: device.name };
    this.connsByDevice.set(device.deviceId, conn);
    void this.store.touchDevice(device.deviceId, this.now());
    sendJson(conn.socket, {
      type: 'auth-ok',
      serverName: this.backend.serverName,
      version: this.backend.version,
      deviceId: device.deviceId,
    });
    conn.pingTimer = setInterval(() => {
      sendJson(conn.socket, { type: 'ping', params: { ts: Date.now() } });
    }, this.pingIntervalMs);
    conn.pingTimer.unref();
    this.opts.onStatusChange?.();
    log(this.opts, `device ${device.name} (${device.deviceId}) authenticated`);
  }

  // ————— JSON-RPC (§4) —————

  private async handleRpc(conn: Conn, id: unknown, method: string, params: unknown): Promise<void> {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const fail = (message: string): void => sendJson(conn.socket, jsonError(id, -32000, message));
    const ok = (result: unknown): void => sendJson(conn.socket, { id, result });
    try {
      switch (method) {
        case 'sessions.list': {
          ok(await this.backend.listSessions());
          return;
        }
        case 'tiles.list':
        case 'tile.list': {
          if (typeof p.sessionId !== 'string') {
            fail('sessionId required');
            return;
          }
          ok(await this.backend.listTiles(p.sessionId));
          return;
        }
        case 'tile.subscribe': {
          if (typeof p.sessionId !== 'string' || typeof p.tileId !== 'string') {
            fail('sessionId and tileId required');
            return;
          }
          const liveTileId = await this.backend.liveTileOf(p.sessionId, p.tileId);
          conn.subs.set(`${p.sessionId}/${p.tileId}`, { sessionId: p.sessionId, liveTileId });
          // stream one snapshot of the recent scrollback tail (§4)
          const snapshot = await this.backend.snapshot(p.tileId);
          sendJson(conn.socket, { type: 'tile.snapshot', params: { tileId: p.tileId, data: snapshot } });
          ok({ ok: true });
          return;
        }
        case 'tile.unsubscribe': {
          if (typeof p.tileId !== 'string') {
            fail('tileId required');
            return;
          }
          for (const key of [...conn.subs.keys()]) {
            if (conn.subs.get(key)?.sessionId !== undefined && key.endsWith(`/${p.tileId}`)) conn.subs.delete(key);
          }
          ok({ ok: true });
          return;
        }
        case 'scrollback.read': {
          if (typeof p.tileId !== 'string') {
            fail('tileId required');
            return;
          }
          const tail = typeof p.tail === 'number' ? p.tail : undefined;
          ok({ data: await this.backend.readScrollback(p.tileId, tail) });
          return;
        }
        case 'task.send': {
          const kind = p.kind === 'note' ? 'note' : 'task';
          if (typeof p.agentId !== 'string' || typeof p.body !== 'string') {
            fail('agentId and body required');
            return;
          }
          ok(await this.backend.sendTask({ agentId: p.agentId, kind, body: p.body }));
          return;
        }
        case 'messages.list': {
          const limit = typeof p.limit === 'number' ? p.limit : undefined;
          ok(await this.backend.listMessages(limit));
          return;
        }
        case 'agent.spawn': {
          ok(
            await this.backend.spawnAgent({
              cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
              kind: typeof p.kind === 'string' ? p.kind : undefined,
              name: typeof p.name === 'string' ? p.name : undefined,
            }),
          );
          return;
        }
        case 'health':
          ok({ ok: true, ts: Date.now() });
          return;
        default:
          sendJson(conn.socket, jsonError(id, -32601, `unknown method: ${method}`));
      }
    } catch (err) {
      sendJson(conn.socket, jsonError(id, -32000, `internal error: ${(err as Error).message}`));
    }
  }

  private scheduleRotate(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    const code = this.codes?.currentOrNew();
    if (!code) return;
    const until = Math.max(1_000, code.expiresAt - this.now() + 1_000);
    this.rotateTimer = setTimeout(() => {
      this.rotateTimer = null;
      this.codes?.rotate();
      this.opts.onStatusChange?.();
      this.scheduleRotate();
    }, until);
    this.rotateTimer.unref();
  }
}
