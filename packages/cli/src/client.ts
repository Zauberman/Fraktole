import { type FraktoleConfig } from '@fraktole/core';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOpts {
  baseUrl: string;
  token: string;
}

export interface CmdContext {
  configPath: string;
  config: FraktoleConfig;
  opts: ClientOpts;
}

export async function loadContext(configPath?: string, autoStart = true): Promise<CmdContext> {
  const path = configPath ?? process.env.FRAKTOLE_CONFIG ?? (await import('@fraktole/core')).defaultConfigPath();
  const { ensureConfig } = await import('@fraktole/core');
  const config = await ensureConfig(path);
  const opts = clientOptsFromConfig(config);
  if (autoStart) {
    const { ensureDaemon } = await import('@fraktole/daemon/spawn-daemon.js');
    await ensureDaemon({
      configPath: path,
      healthCheck: async () => {
        try {
          await apiRequest(opts, 'GET', '/v1/tasks');
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  return { configPath: path, config, opts };
}

export function clientOptsFromConfig(config: FraktoleConfig): ClientOpts {
  const token = process.env.FRAKTOLE_TOKEN ?? config.server.tokens[0];
  if (!token) {
    throw new CliError(
      'no auth token configured: set server.tokens in the config file or the FRAKTOLE_TOKEN env var',
    );
  }
  const scheme = config.server.tls ? 'https' : 'http';
  return { baseUrl: `${scheme}://${config.server.host}:${config.server.port}`, token };
}

/** true for loopback hosts — the only case where a TLS→http fallback is safe */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

async function doFetch(baseUrl: string, opts: ClientOpts, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function apiRequest<T>(
  opts: ClientOpts,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await doFetch(opts.baseUrl, opts, method, path, body);
  } catch (err) {
    // TLS down on loopback → graceful local-http fallback (never for remote hosts)
    const host = new URL(opts.baseUrl).hostname;
    if (opts.baseUrl.startsWith('https://') && isLoopbackHost(host)) {
      const httpUrl = opts.baseUrl.replace(/^https:\/\//, 'http://');
      console.error('[fraktole] TLS unreachable, falling back to local http (loopback only)');
      res = await doFetch(httpUrl, opts, method, path, body);
    } else {
      throw err;
    }
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  return { status: res.status, data };
}
