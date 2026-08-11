import {
  ROUTES,
  WS_PATH,
  defaultConfigPath,
  type CreateTaskBody,
  type EventEnvelope,
  type Task,
} from '@fraktole/core';
import { WebSocket } from 'ws';
import { apiRequest, type CmdContext } from './client.js';

export interface DispatchOpts {
  repo?: string;
  driver?: string;
  baseBranch?: string;
}

export async function cmdDispatch(ctx: CmdContext, goal: string, opts: DispatchOpts): Promise<void> {
  const repoPath = await resolveRepoPath(ctx, opts.repo);
  const body: CreateTaskBody = {
    goal,
    repoPath,
    baseBranch: opts.baseBranch ?? 'main',
    // driver absent => orchestrator task decomposed by the planner
    ...(opts.driver !== undefined ? { driver: opts.driver } : {}),
  };
  const { data } = await apiRequest<{ task: Task }>(ctx.opts, 'POST', ROUTES.createTask, body);
  console.log(`created task ${data.task.id} [${data.task.status}] branch ${data.task.branch}`);
}

/**
 * Resolves the dispatch target repo: the explicit --repo when given, otherwise
 * the git toplevel of the current directory (auto-registered with the daemon),
 * falling back to the plain current directory when no repo is involved.
 */
async function resolveRepoPath(ctx: CmdContext, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  let root: string;
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
    });
    root = stdout.trim();
  } catch {
    root = process.cwd();
  }
  await apiRequest(ctx.opts, 'POST', ROUTES.repos, { path: root });
  return root;
}

export async function cmdStatus(ctx: CmdContext, json: boolean): Promise<void> {
  const { data } = await apiRequest<{ tasks: Task[] }>(ctx.opts, 'GET', ROUTES.listTasks);
  if (json) {
    console.log(JSON.stringify(data.tasks, null, 2));
    return;
  }
  if (data.tasks.length === 0) {
    console.log('no tasks');
    return;
  }
  for (const t of data.tasks) {
    console.log(`${t.id}  ${t.status.padEnd(9)} ${t.driver.padEnd(8)} ${t.branch}  ${t.goal}`);
  }
}

export async function cmdLogs(
  ctx: CmdContext,
  taskId: string,
  opts: { follow: boolean },
): Promise<void> {
  if (opts.follow) {
    await followLogs(ctx, taskId, (ev) => process.stdout.write(ev.payload.text));
    return;
  }
  const { data } = await apiRequest<{ task: Task; log: Array<{ stream: string; text: string }> }>(
    ctx.opts,
    'GET',
    `/v1/tasks/${taskId}`,
  );
  if (data.log.length === 0) {
    console.log(`(no log for task ${taskId}, status ${data.task.status})`);
    return;
  }
  for (const line of data.log) {
    process.stdout.write(line.text);
  }
}

export async function cmdCancel(ctx: CmdContext, taskId: string): Promise<void> {
  const { data } = await apiRequest<{ task: Task }>(ctx.opts, 'POST', `/v1/tasks/${taskId}/cancel`);
  console.log(`task ${taskId} ${data.task.status}`);
}

export async function cmdGates(
  ctx: CmdContext,
  sub: string,
  gateId?: string,
): Promise<void> {
  if (sub === 'list') {
    const { data } = await apiRequest<{ tasks: Task[] }>(ctx.opts, 'GET', ROUTES.listTasks);
    const gates = data.tasks.flatMap((t) =>
      t.gates.filter((g) => g.status === 'open').map((g) => ({ taskId: t.id, ...g })),
    );
    if (gates.length === 0) {
      console.log('no open gates');
      return;
    }
    for (const g of gates) {
      console.log(`${g.id}  ${g.kind.padEnd(18)} ${g.taskId}  ${g.reason}`);
    }
    return;
  }
  if ((sub === 'approve' || sub === 'deny') && gateId) {
    await apiRequest(ctx.opts, 'POST', `/v1/gates/${gateId}/resolve`, { decision: sub });
    console.log(`gate ${gateId} ${sub}d`);
    return;
  }
  throw new Error('usage: fraktole gates list | gates approve <id> | gates deny <id>');
}

export async function cmdConfigPath(): Promise<void> {
  console.log(process.env.FRAKTOLE_CONFIG ?? defaultConfigPath());
}

export async function cmdPair(ctx: CmdContext, sub?: string, deviceId?: string): Promise<void> {
  if (sub === 'revoke') {
    if (!deviceId) throw new Error('usage: fraktole pair revoke <deviceId>');
    await apiRequest(ctx.opts, 'POST', `/v1/devices/${deviceId}/revoke`);
    console.log(`device ${deviceId} revoked`);
    return;
  }
  if (sub !== undefined) throw new Error('usage: fraktole pair | fraktole pair revoke <deviceId>');
  const { data } = await apiRequest<{ code: string; ttlMs: number }>(ctx.opts, 'POST', '/v1/devices/codes');
  console.log(`pairing code: ${data.code}`);
  console.log(`(valid for ${Math.round(data.ttlMs / 60000)} minutes; exchange it on the phone via POST /v1/devices/pair)`);
}

import { loadContext } from './client.js';

export async function cmdStart(configPath?: string): Promise<void> {
  const ctx = await loadContext(configPath, false);
  const { ensureDaemon } = await import('@fraktole/daemon/spawn-daemon.js');
  const ok = await ensureDaemon({
    configPath: ctx.configPath,
    healthCheck: async () => {
      try {
        await apiRequest(ctx.opts, 'GET', ROUTES.listTasks);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!ok) throw new Error('daemon did not become reachable within 5s');
  console.log(`daemon started at ${ctx.opts.baseUrl}`);
}

export async function followLogs(
  ctx: CmdContext,
  taskId: string,
  onEvent: (ev: Extract<EventEnvelope, { kind: 'LogChunk' }>) => void,
  onSocket?: (ws: WebSocket) => void,
): Promise<void> {
  const url = `${ctx.opts.baseUrl.replace(/^http/, 'ws')}${WS_PATH}`;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${ctx.opts.token}` } });
    onSocket?.(ws);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out connecting to daemon'));
    }, 10_000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'get', since: -1 }));
    });
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data)) as EventEnvelope;
      if (ev.kind === 'LogChunk' && ev.taskId === taskId) {
        onEvent(ev);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
