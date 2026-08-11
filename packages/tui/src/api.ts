import {
  cancelTaskPath,
  defaultConfigPath,
  loadConfig,
  resolveGatePath,
  ROUTES,
  type CreateTaskBody,
  type RepoConfig,
  type Task,
} from '@fraktole/core';

export interface DiscoveredDriver {
  id: string;
  command: string;
  installed: boolean;
}

export interface TuiApi {
  cancel(taskId: string): Promise<void>;
  resolveGate(gateId: string, decision: 'approve' | 'deny'): Promise<void>;
  createTask(body: CreateTaskBody): Promise<Task>;
  listRepos(): Promise<RepoConfig[]>;
  addRepo(path: string): Promise<RepoConfig>;
  removeRepo(path: string): Promise<void>;
  listDrivers(): Promise<DiscoveredDriver[]>;
}

export async function apiFor(): Promise<TuiApi> {
  const config = await loadConfig(process.env.FRAKTOLE_CONFIG ?? defaultConfigPath());
  const token = process.env.FRAKTOLE_TOKEN ?? config.server.tokens[0];
  if (!token) {
    throw new Error('no auth token configured: set server.tokens in the config or FRAKTOLE_TOKEN');
  }
  const scheme = config.server.tls ? 'https' : 'http';
  const baseUrl = `${scheme}://${config.server.host}:${config.server.port}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // TLS down on loopback → graceful local-http fallback (never remote)
      const host = new URL(baseUrl).hostname;
      if (baseUrl.startsWith('https://') && (host === '127.0.0.1' || host === 'localhost')) {
        res = await fetch(`${baseUrl.replace(/^https:\/\//, 'http://')}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } else {
        throw err;
      }
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  return {
    async cancel(taskId) {
      await request<{ task: Task }>('POST', cancelTaskPath(taskId));
    },
    async resolveGate(gateId, decision) {
      await request('POST', resolveGatePath(gateId), { decision });
    },
    async createTask(body) {
      const { task } = await request<{ task: Task }>('POST', ROUTES.createTask, body);
      return task;
    },
    async listRepos() {
      const { repos } = await request<{ repos: RepoConfig[] }>('GET', ROUTES.repos);
      return repos;
    },
    async addRepo(path) {
      const { repo } = await request<{ repo: RepoConfig }>('POST', ROUTES.repos, { path });
      return repo;
    },
    async removeRepo(path) {
      await request('DELETE', ROUTES.repos, { path });
    },
    async listDrivers() {
      const { drivers } = await request<{ drivers: DiscoveredDriver[] }>('GET', ROUTES.drivers);
      return drivers;
    },
  };
}
