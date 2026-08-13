import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FraktoleMessage, ReviewerState, ReviewerTask } from '../src/shared/ipc.js';
import { ORCHESTRATOR_ID, messageId } from './mailbox.js';
import type { TileRecorder } from './tile-recorder.js';

/** What the harness can reach: the live recording, the mailboxes, and the
 *  project the session is bound to. */
export interface ReviewerToolContext {
  sessionId: string;
  sessionDir: string;
  cwd: string;
  recorder: TileRecorder;
  router: {
    sendFromOrchestrator(msg: FraktoleMessage): Promise<boolean>;
  };
  tileOfAgent(agentId: string): string | null;
  agentOfTile(tileId: string): string | null;
  cwdOfAgent(agentId: string): string | null;
  /** The durable goal/task ledger; the host owns persistence and always
   *  injects these two callbacks when it builds the merged context. */
  getState?(): ReviewerState;
  updateTask?(task: ReviewerTask): Promise<void>;
}

export interface ReviewerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ReviewerToolContext): Promise<string>;
}

const TOOL_RESULT_CAP = 20_000;

export function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n…[truncated]`;
}

const TOOLS: ReviewerTool[] = [
  {
    name: 'list_tiles',
    description: 'List every agent tile in this session: agent id, tile id, working dir, recorded line count.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const rows = Array.from(ctx.recorder.list().entries()).map(([tileId, summary]) => {
        const agentId = ctx.agentOfTile(tileId) ?? tileId;
        return { tileId, agentId, cwd: ctx.cwdOfAgent(agentId), lines: summary.lines };
      });
      if (rows.length === 0) return 'no tiles recorded yet';
      return JSON.stringify(rows, null, 2);
    },
  },
  {
    name: 'read_tile',
    description:
      'Read the live recording of an agent tile: the last `tail` lines, or lines matching `grep`. Use a small tail (5-40) unless you need more; full history lives in read_scrollback.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
        tileId: { type: 'string' },
        tail: { type: 'number', description: 'last N lines to return (default 40)' },
        grep: { type: 'string', description: 'return only lines matching this regex' },
      },
    },
    async run(args, ctx) {
      const tileId = resolveTile(args, ctx);
      if (!tileId) return 'error: unknown tile — call list_tiles first';
      if (typeof args.grep === 'string' && args.grep.length > 0) {
        let re: RegExp;
        try {
          re = new RegExp(args.grep);
        } catch (err) {
          return `error: bad grep regex: ${String(err)}`;
        }
        return capResult(ctx.recorder.search(tileId, re).join('\n') || '(no matches)');
      }
      const n = clampInt(args.tail, 40, 1, 500);
      return capResult(ctx.recorder.tail(tileId, n).join('\n') || '(empty)');
    },
  },
  {
    name: 'read_scrollback',
    description: 'Read the persisted scrollback of an agent (full history captured at save time). Returns up to 1000 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        tail: { type: 'number', description: 'last N lines (default 200, max 1000)' },
      },
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId : '';
      if (!agentId) return 'error: agentId required';
      let raw: string;
      try {
        raw = await readFile(join(ctx.sessionDir, 'scrollback', `${agentId}.json`), 'utf8');
      } catch {
        return 'error: no scrollback for this agent yet';
      }
      let lines: string[];
      try {
        lines = (JSON.parse(raw) as { lines: string[] }).lines ?? [];
      } catch {
        return 'error: corrupt scrollback file';
      }
      const n = clampInt(args.tail, 200, 1, 1000);
      return capResult(lines.slice(-n).join('\n') || '(empty)');
    },
  },
  {
    name: 'send_message',
    description: 'Send a task or note to an agent. Tasks get results back through the mailboxes; notes are informational.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'agent id (from list_tiles)' },
        kind: { type: 'string', enum: ['task', 'note'] },
        body: { type: 'string' },
      },
      required: ['to', 'kind', 'body'],
    },
    async run(args, ctx) {
      const to = typeof args.to === 'string' ? args.to : '';
      const kind = args.kind === 'task' ? 'task' : args.kind === 'note' ? 'note' : null;
      const body = typeof args.body === 'string' ? args.body : '';
      if (!to || !kind) return 'error: to, kind (task|note) and body are required';
      const ok = await ctx.router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to,
        kind,
        body,
        at: Date.now(),
      });
      return ok ? `sent ${kind} to ${to}` : `error: cannot reach ${to} (unknown agent?)`;
    },
  },
  {
    name: 'read_state',
    description: 'Return the current goal and task ledger (the durable watchdog state).',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return JSON.stringify(ctx.getState?.() ?? ({ goal: null, tasks: [] } as ReviewerState), null, 2);
    },
  },
  {
    name: 'update_task',
    description:
      'Upsert a row in the task ledger: give id to update an existing task, or omit it to create one (a fresh id is assigned). status is one of pending, active, done, failed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        agentId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
      },
      required: ['title'],
    },
    async run(args, ctx) {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title.length === 0) return 'error: title required';
      const status =
        args.status === 'pending' || args.status === 'active' || args.status === 'done' || args.status === 'failed'
          ? args.status
          : 'pending';
      const task: ReviewerTask = {
        id: typeof args.id === 'string' && args.id.length > 0 ? args.id : newTaskId(),
        agentId: typeof args.agentId === 'string' && args.agentId.length > 0 ? args.agentId : null,
        title,
        status,
        updatedAt: Date.now(),
      };
      await ctx.updateTask?.(task);
      return `task ${task.id} ${task.status === 'pending' ? 'recorded' : `→ ${task.status}`}`;
    },
  },
  {
    name: 'run_bash',
    description: 'Run a shell command in the session project (or an agent\'s working dir). Output is capped at 64 KiB.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'working directory (defaults to the project root)' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command) return 'error: command required';
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd;
      return runShell(command, cwd);
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project (or an absolute path). Cap: 4 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return 'error: path required';
      const abs = path.startsWith('/') ? path : join(ctx.cwd, path);
      try {
        const content = await readFile(abs, 'utf8');
        if (content.length > 4 * 1024 * 1024) return 'error: file larger than 4 MiB';
        return content;
      } catch (err) {
        return `error: ${(err as NodeJS.ErrnoException).message}`;
      }
    },
  },
];

export class ReviewerTools {
  private readonly tools = new Map(TOOLS.map((t) => [t.name, t]));

  definitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async run(name: string, args: Record<string, unknown>, ctx: ReviewerToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `error: unknown tool ${name}`;
    try {
      return await tool.run(args, ctx);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }
}

function resolveTile(args: Record<string, unknown>, ctx: ReviewerToolContext): string | null {
  if (typeof args.tileId === 'string' && args.tileId.length > 0) return args.tileId;
  if (typeof args.agentId === 'string' && args.agentId.length > 0) return ctx.tileOfAgent(args.agentId);
  return null;
}

/** Ledger task ids must be unique per session; a per-process counter keeps
 *  them distinct even when two upserts land in the same ms. */
let taskSeq = 0;
function newTaskId(): string {
  taskSeq += 1;
  return `t-${Date.now()}-${taskSeq}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/bash',
      ['-lc', command],
      { cwd, timeout: 30_000, maxBuffer: 64 * 1024 + 4096, env: { ...process.env, PWD: cwd } },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.trim();
        if (err) {
          const killed = (err as { killed?: boolean }).killed === true;
          const kind = killed ? 'timed out after 30s' : (err as Error).message;
          resolve(out.length > 0 ? `error: ${kind}\n${out}` : `error: ${kind}`);
          return;
        }
        resolve(out.length > 0 ? out : '(no output)');
      },
    );
    void child;
  });
}
