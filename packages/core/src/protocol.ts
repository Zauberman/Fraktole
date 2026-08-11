export const WS_PATH = '/ws';
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const DEFAULT_PORT = 8756;

export const ROUTES = {
  createTask: '/v1/tasks',
  listTasks: '/v1/tasks',
  getTask: '/v1/tasks/:id',
  cancelTask: '/v1/tasks/:id/cancel',
  resolveGate: '/v1/gates/:id/resolve',
  pairDevice: '/v1/devices/pair',
  repos: '/v1/repos',
  drivers: '/v1/drivers',
} as const;

export function taskPath(id: string): string {
  return `/v1/tasks/${id}`;
}

export function cancelTaskPath(id: string): string {
  return `/v1/tasks/${id}/cancel`;
}

export function resolveGatePath(gateId: string): string {
  return `/v1/gates/${gateId}/resolve`;
}

export interface CreateTaskBody {
  goal: string;
  repoPath: string;
  driver?: string;
  baseBranch?: string;
  /** explicit orchestration flag; defaults to "no driver ⇒ orchestrate" */
  orchestrate?: boolean;
}

export interface ResolveGateBody {
  decision: 'approve' | 'deny';
}

export type WsClientMessage = { type: 'subscribe' } | { type: 'get'; since: number };
