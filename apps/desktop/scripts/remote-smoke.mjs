#!/usr/bin/env node
// Fraktole Remote — interop smoke test.
//
// Proves the desktop WSS bridge (docs/remote-protocol.md) end to end:
//   1. pair with a one-time code      (or reuse a saved token)
//   2. authenticate
//   3. sessions.list / tiles.list / tile.subscribe (3s of events)
//   4. scrollback.read / messages.list / health
//   5. task.send into the orchestrator mailbox   (optional --task)
//   6. agent.spawn                              (optional --spawn)
//
// Usage:
//   node scripts/remote-smoke.mjs --enable            # persist enabled-state
//   node scripts/remote-smoke.mjs --pair AB12-CD34    # pair + save token
//   node scripts/remote-smoke.mjs --token <64hex>     # auth with an explicit token
//   node scripts/remote-smoke.mjs --task "do x" --spawn
//   node scripts/remote-smoke.mjs --host 192.168.1.5 --port 8833
//
// Pairing credentials are saved (plaintext) under the app userData dir so a
// second run can skip pairing; the desktop only ever stores the hash.

import { WebSocket } from 'ws';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8833;
const USER_DATA = process.env.FRAKTOLE_USER_DATA ?? join(homedir(), '.config', 'Fraktole');
const CREDS_FILE = join(USER_DATA, 'remote', 'smoke-creds.json');
const STATE_FILE = join(USER_DATA, 'remote', 'state.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

const host = arg('--host') ?? DEFAULT_HOST;
const port = Number(arg('--port') ?? DEFAULT_PORT);

// ————— helpers —————

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
      this.queue.push(msg);
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor(pred, timeoutMs = 10_000) {
    const idx = this.queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('timed out waiting for a server frame'));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  async rpc(id, method, params) {
    this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    return this.waitFor((m) => m?.id === id);
  }
}

function connect() {
  const url = `wss://${host}:${port}`;
  console.log(`connecting ${url} (accepting any cert — fingerprint checked by the desktop UI)`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    ws.once('open', () => resolve(new Client(ws)));
    ws.once('error', reject);
  });
}

function fail(msg) {
  console.error(`\nSMOKE FAILED: ${msg}`);
  process.exitCode = 1;
}

function pass(msg) {
  console.log(`  ok: ${msg}`);
}

function saveCreds(creds) {
  mkdirSync(join(USER_DATA, 'remote'), { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), 'utf8');
  console.log(`  saved token to ${CREDS_FILE} (desktop stores only the hash)`);
}

// ————— mode 1: --enable —————

if (has('--enable')) {
  const current = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  mkdirSync(join(USER_DATA, 'remote'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ ...current, enabled: true, port }, null, 2), 'utf8');
  console.log(`bridge enabled in ${STATE_FILE}`);
  console.log('start the desktop app (pnpm dev) and open the Remote tab to grab the pairing code');
  process.exit(0);
}

// ————— pair —————

async function pair(code) {
  const client = await connect();
  client.send({ type: 'pair', code, deviceName: `smoke-${process.platform}` });
  const reply = await client.waitFor((m) => m?.type === 'pair-ok' || m?.type === 'pair-fail');
  if (reply.type !== 'pair-ok') {
    fail(`pairing rejected: ${reply.reason ?? 'unknown'}`);
    process.exit(1);
  }
  pass(`paired as ${reply.deviceId} (fingerprint ${reply.serverFingerprint.slice(0, 16)}…)`);
  return reply;
}

// ————— main —————

async function main() {
  let creds = null;
  if (has('--pair')) {
    const code = arg('--pair');
    const reply = await pair(code);
    creds = { token: reply.token, deviceId: reply.deviceId, serverFingerprint: reply.serverFingerprint, host, port };
    saveCreds(creds);
  } else {
    const explicit = arg('--token');
    if (explicit) {
      creds = { token: explicit, deviceId: 'unknown', host, port };
    } else if (existsSync(CREDS_FILE)) {
      try {
        creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
        console.log(`reusing saved token for ${creds.deviceId ?? 'device'}`);
      } catch {
        fail(`cannot read ${CREDS_FILE}`);
        process.exit(1);
      }
    } else {
      console.error(
        [
          'no token available. Either:',
          `  node scripts/remote-smoke.mjs --pair <CODE>   (code shown in the Remote tab)`,
          `  node scripts/remote-smoke.mjs --token <hex64>  (token from a previous pair)`,
          `  node scripts/remote-smoke.mjs --enable         (turn the bridge on first)`,
        ].join('\n'),
      );
      process.exit(1);
    }
  }

  // ————— auth —————
  const client = await connect();
  client.send({ type: 'auth', token: creds.token });
  const auth = await client.waitFor((m) => m?.type === 'auth-ok' || m?.type === 'auth-fail');
  if (auth.type !== 'auth-ok') {
    fail('authentication rejected — revoke + re-pair the device');
    process.exit(1);
  }
  pass(`authenticated: ${auth.serverName} v${auth.version} as ${auth.deviceId}`);

  // ————— RPC —————
  const health = await client.rpc(1, 'health');
  if (health.error) return fail(`health: ${health.error.message}`);
  pass('health');

  const sessions = await client.rpc(2, 'sessions.list');
  if (sessions.error) return fail(`sessions.list: ${sessions.error.message}`);
  const rows = sessions.result;
  console.log(`  sessions: ${rows.length > 0 ? rows.map((s) => `${s.name}(${s.id})`).join(', ') : 'none'}`);
  pass(`sessions.list (${rows.length})`);

  const target = rows[0];
  let tile = null;
  if (target) {
    const tiles = await client.rpc(3, 'tiles.list', { sessionId: target.id });
    if (tiles.error) return fail(`tiles.list: ${tiles.error.message}`);
    console.log(`  tiles: ${tiles.result.map((t) => `${t.id}[${t.kind}]`).join(', ') || 'none'}`);
    pass(`tiles.list (${tiles.result.length})`);
    tile = tiles.result[0];

    if (tile) {
      const sub = await client.rpc(4, 'tile.subscribe', { sessionId: target.id, tileId: tile.id });
      if (sub.error) return fail(`tile.subscribe: ${sub.error.message}`);
      const snapshot = await client.waitFor((m) => m?.type === 'tile.snapshot', 5_000);
      console.log(`  snapshot: ${JSON.stringify(snapshot.params.data).slice(0, 120)}…`);
      pass('tile.subscribe + snapshot');

      // listen for 3s of live output
      const events = [];
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          const ev = await client.waitFor((m) => m?.type === 'tile.output' || m?.type === 'tile.state' || m?.type === 'ping', deadline - Date.now());
          events.push(ev.type);
          if (ev.type === 'tile.output') console.log(`  output: ${JSON.stringify(ev.params.data).slice(0, 100)}`);
        } catch {
          break;
        }
      }
      pass(`subscribed tile ${tile.id} for 3s (${events.length} events)`);

      const scroll = await client.rpc(5, 'scrollback.read', { tileId: tile.id, tail: 20 });
      if (scroll.error) return fail(`scrollback.read: ${scroll.error.message}`);
      console.log(`  scrollback: ${JSON.stringify(scroll.result.data).slice(0, 120)}…`);
      pass('scrollback.read');

      await client.rpc(6, 'tile.unsubscribe', { tileId: tile.id });

      const body = arg('--task') ?? `smoke test from remote-smoke.mjs at ${new Date().toISOString()}`;
      const task = await client.rpc(7, 'task.send', { agentId: tile.id, kind: 'task', body });
      if (task.error || task.result?.ok !== true) return fail(`task.send: ${task.error?.message ?? JSON.stringify(task.result)}`);
      pass(`task.send → ${task.result.messageId} (delivered to ${tile.id})`);
    }
  }

  const msgs = await client.rpc(8, 'messages.list', { limit: 10 });
  if (msgs.error) return fail(`messages.list: ${msgs.error.message}`);
  pass(`messages.list (${msgs.result.length})`);

  if (has('--spawn')) {
    const spawn = await client.rpc(9, 'agent.spawn', {});
    if (spawn.error || spawn.result?.ok !== true) return fail(`agent.spawn: ${spawn.error?.message ?? JSON.stringify(spawn.result)}`);
    pass(`agent.spawn → ${spawn.result.agentId}`);
  }

  console.log('\nSMOKE PASSED');
  client.ws.close();
  process.exit(0);
}

main().catch((err) => {
  if (process.env.DEBUG) console.error(err);
  fail(err instanceof Error ? err.message : String(err));
});
