import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDaemon, type Daemon } from '../src/index.js';
import { createFraktoleServer } from '../src/server.js';

const execFileP = promisify(execFile);

const TOKEN = 'tls-token';
const INSTALLED = [{ id: 'opencode', command: 'opencode', installed: true }];

let daemon: Daemon;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-tls-'));
  await execFileP('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir: join(dir, 'data'),
      server: {
        tokens: [TOKEN],
        tls: { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') },
      },
    }),
  );
  daemon = await runDaemon(configPath);
  const server = createFraktoleServer({
    engine: daemon.engine,
    bus: daemon.bus,
    tokens: [TOKEN],
    tls: { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') },
    drivers: INSTALLED,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
});

afterAll(async () => {
  await closeServer();
});

describe('TLS server', () => {
  it('serves the API over https with a self-signed certificate', async () => {
    const old = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await fetch(`${baseUrl}/v1/tasks`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tasks: unknown[] }).tasks).toEqual([]);
    } finally {
      if (old === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = old;
    }
  });
});
