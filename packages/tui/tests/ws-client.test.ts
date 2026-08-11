import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WS_PATH, type EventEnvelope } from '@fraktole/core';
import { WebSocketServer } from 'ws';
import { WsClient } from '../src/ws-client.js';

const TOKEN = 'tui-token';

let HISTORY: EventEnvelope[] = [
  { id: 'a', ts: new Date().toISOString(), kind: 'TaskQueued', taskId: 't1', seq: 0, payload: { taskId: 't1' } },
  { id: 'b', ts: new Date().toISOString(), kind: 'TaskQueued', taskId: 't2', seq: 1, payload: { taskId: 't2' } },
];

let server: Server | undefined;
let wss: WebSocketServer | undefined;

function startServer(port?: number): Promise<{ baseUrl: string; port: number }> {
  server = createServer();
  wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; since: number };
      if (msg.type === 'get') {
        for (const ev of HISTORY.filter((e) => e.seq > msg.since)) {
          ws.send(JSON.stringify(ev));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server!.listen(port ?? 0, '127.0.0.1', () => {
      const bound = (server!.address() as AddressInfo).port;
      resolve({ baseUrl: `http://127.0.0.1:${bound}`, port: bound });
    });
  });
}

async function stopServer(): Promise<void> {
  wss?.clients.forEach((ws) => ws.close());
  await new Promise<void>((resolve) => {
    const s = server;
    server = undefined;
    wss = undefined;
    if (!s) return resolve();
    s.closeAllConnections();
    s.close(() => resolve());
  });
}

afterEach(async () => {
  HISTORY = HISTORY.slice(0, 2);
  await stopServer();
});

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('WsClient', () => {
  it('connects, backfills since the last seq, and receives live events', async () => {
    const { baseUrl } = await startServer();
    const client = new WsClient(baseUrl, TOKEN);
    const events: number[] = [];
    let connected: boolean | undefined;
    client.onStateChange = (c) => {
      connected = c;
    };
    client.onEvent = (ev) => events.push(ev.seq);
    client.connect();

    await waitFor(() => events.length >= 2); // backfill of seq 0 and 1
    expect(connected).toBe(true);
    expect(events).toEqual([0, 1]);

    const live: EventEnvelope = {
      id: 'c',
      ts: new Date().toISOString(),
      kind: 'TaskQueued',
      taskId: 't3',
      seq: 2,
      payload: { taskId: 't3' },
    };
    wss!.clients.forEach((ws) => ws.send(JSON.stringify(live)));
    await waitFor(() => events.includes(2));
    expect(events).toEqual([0, 1, 2]);

    client.close();
  });

  it('reconnects with backoff and backfills after the server bounces', async () => {
    const { baseUrl, port } = await startServer();
    const client = new WsClient(baseUrl, TOKEN);
    const events: number[] = [];
    client.onEvent = (ev) => events.push(ev.seq);
    client.connect();
    await waitFor(() => events.length >= 2);

    await stopServer();
    HISTORY = [
      ...HISTORY,
      { id: 'c', ts: new Date().toISOString(), kind: 'TaskQueued', taskId: 't3', seq: 2, payload: { taskId: 't3' } },
    ];
    await startServer(port); // same port, new server instance
    await waitFor(() => events.includes(2), 8000); // backfill sent after reconnect

    client.close();
  });
});
