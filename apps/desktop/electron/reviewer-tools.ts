import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FraktoleMessage, ReviewerQuestion, ReviewerState, ReviewerTask } from '../src/shared/ipc.js';
import { sanitizeChatText } from '../src/shared/sanitize.js';
import { emptyState } from './reviewer-state.js';
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
   *  injects these callbacks when it builds the merged context. */
  getState?(): ReviewerState;
  updateTask?(task: ReviewerTask): Promise<void>;
  /** Suspends the loop until the user answers the question card. */
  askUser?(question: string, kind: ReviewerQuestion['kind'], agentId?: string): Promise<string>;
  /** Raw PTY kill (the host guards grants before routing here). */
  killAgent?(tileId: string): Promise<string>;
  /** Grant-checked kill (single-use per agent); the host enforces policy. */
  tryKillAgent?(agentId: string): Promise<string>;
  /** Spawn an agent tile; main allocates the id and mounts it in the UI. */
  spawnAgent?(kind: string, cwd: string): Promise<string>;
  /** Live agent tile count (spawn cap). */
  agentCount?(): number;
  /** The configured launcher command ('' = none). */
  getAgentCommand?(): string;
  /** Set or clear the watchdog goal (user-authorized: always allowed). */
  setGoal?(text: string): Promise<void>;
  /** Start a long-running background process; returns a job id. */
  runBackground?(command: string, cwd: string): Promise<string>;
  /** Poll a background job's state and recent output. */
  jobStatus?(jobId: string): Promise<string>;
  /** Stop a background job. */
  jobStop?(jobId: string): Promise<string>;
  /** The mailbox message log for the session. */
  listMessages?(): Promise<FraktoleMessage[]>;
  /** Write a command into an existing agent's terminal (launch_agent). */
  writeToAgent?(agentId: string, command: string): Promise<string>;
  /** Reload the Test tab's guest page. */
  reloadTestPage?(): Promise<string>;
  /** Open a URL in the Test tab (the embedded mini browser). */
  openTestPage?(url: string): Promise<string>;
  /** Read the Test tab's live state (url/title/loading/console errors). */
  readTestPage?(): Promise<string>;
  /** Save a screenshot of the Test tab for the user; returns the path. */
  screenshotTestPage?(): Promise<string>;
}

export interface ReviewerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ReviewerToolContext): Promise<string>;
}

const TOOL_RESULT_CAP = 20_000;

/** Named key combos for send_keystroke — shift-tab is the opencode
 *  plan/build toggle (xterm CSI Z). */
const KEY_ESCAPES: Record<string, string> = {
  'shift-tab': '\x1b[Z',
  tab: '\t',
  enter: '\r',
  escape: '\x1b',
  'ctrl-c': '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

export function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n…[truncated]`;
}

const TOOLS: ReviewerTool[] = [
  {
    name: 'list_tiles',
    description: 'List every agent tile: agent id, tile id, working dir, recorded line count, and seconds since the tile last produced output (dead-tile detection). Call this FIRST at the start of an engagement.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const now = Date.now();
      const rows = Array.from(ctx.recorder.list().entries()).map(([tileId, summary]) => {
        const agentId = ctx.agentOfTile(tileId) ?? tileId;
        return {
          tileId,
          agentId,
          cwd: ctx.cwdOfAgent(agentId),
          lines: summary.lines,
          lastActiveAgoSec: Math.max(0, Math.round((now - summary.lastAt) / 1000)),
        };
      });
      if (rows.length === 0) return 'no tiles recorded yet';
      return JSON.stringify(rows, null, 2);
    },
  },
  {
    name: 'read_tile',
    description:
      'Read the live recording of an agent tile: the last `tail` lines, or lines matching `grep`. Prefer a small tail (5-40). The recording is transient — use read_scrollback for the persisted full history.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
        tileId: { type: 'string', description: 'tile id (from list_tiles); agentId also works' },
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
    description: "Read the persisted scrollback of an agent (full history captured at save time, up to 1000 lines). Use it when read_tile's live tail is not enough to judge a completed piece of work.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
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
    description: 'Send a task or note to an agent. Tasks get results back through the mailboxes and wake you; notes are informational. Always state precise, verifiable acceptance criteria in the body. Prefer this over doing work yourself when an agent owns the area.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'agent id (from list_tiles)' },
        kind: { type: 'string', enum: ['task', 'note'], description: 'task = work to do (a result wakes you); note = informational' },
        body: { type: 'string', description: 'the message body, with precise acceptance criteria for tasks' },
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
    description: 'Return the current goal and task ledger (the durable watchdog state). Check it when you need to recall what was assigned, to whom, and in what state.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return JSON.stringify(ctx.getState?.() ?? emptyState(), null, 2);
    },
  },
  {
    name: 'update_task',
    description:
      'Upsert a row in the task ledger: give id to update an existing task, omit it to create one. status: pending/active/done/failed. Keep the ledger current on every assignment and every completion — it is your durable memory across compactions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'existing task id to update (omit to create)' },
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
        title: { type: 'string', description: 'short task title' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'], description: 'ledger state of the task' },
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
    name: 'ask_user',
    description:
      'Ask the user a question and WAIT for the answer (the loop suspends). Use it before destructive or uncertain steps: kill confirmations (kind confirm-kill, a yes grants one kill), spawn launcher picks (kind agent-kind), or any free-form decision (kind free).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question shown to the user' },
        kind: { type: 'string', enum: ['free', 'confirm-kill', 'agent-kind'], description: 'confirm-kill shows yes/no and grants a kill; agent-kind picks a launcher; free is plain text' },
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
      },
      required: ['question'],
    },
    async run(args, ctx) {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (question.length === 0) return 'error: question required';
      const kind = args.kind === 'confirm-kill' || args.kind === 'agent-kind' ? args.kind : 'free';
      const agentId = typeof args.agentId === 'string' && args.agentId.length > 0 ? args.agentId : undefined;
      if (!ctx.askUser) return 'error: ask_user unavailable';
      try {
        const answer = await ctx.askUser(question, kind, agentId);
        return `user answered: ${sanitizeChatText(answer)}`;
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'kill_agent',
    description:
      'Kill an agent tile (terminates its PTY and closes the tile). REQUIRES a single-use user grant: ask the user first with ask_user (kind confirm-kill, agentId) and only call this after they answer yes. The user may also kill directly with /kill. Never target the orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
      },
      required: ['agentId'],
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
      if (agentId.length === 0) return 'error: agentId required';
      return ctx.tryKillAgent?.(agentId) ?? 'error: kill unavailable';
    },
  },
  {
    name: 'spawn_agent',
    description:
      "Spawn a NEW agent tile (a shell in cwd with the launch command written into it). Fire a known kind directly (the ledger remembers the user's choice) or omit kind to let the user pick. Capped at 8 agents. To run a harness inside an EXISTING tile instead, use launch_agent.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'working directory (defaults to the project root)' },
        kind: { type: 'string', description: 'launcher (e.g. opencode, shell, or a command); empty = user picks' },
      },
    },
    async run(args, ctx) {
      const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : '';
      const kindArg = typeof args.kind === 'string' ? args.kind.trim() : '';
      const configCommand = ctx.getAgentCommand?.() ?? '';
      let kind = kindArg;
      if (kind.length === 0) kind = ctx.getState?.().lastAgentKind ?? '';
      if (kind.length === 0) kind = configCommand;
      if (kind.length === 0) {
        if (!ctx.askUser) return 'error: no agent kind — ask the user which agent to spawn';
        kind = (await ctx.askUser('which agent should I spawn? (opencode, shell, or a launcher command)', 'agent-kind')).trim();
        if (/^(skipped?|skip)$/i.test(kind)) return 'error: spawn cancelled by the user';
      }
      if (kind.length === 0) return 'error: no agent kind';
      const count = ctx.agentCount?.() ?? 0;
      if (count >= 8) return `error: agent cap (8) reached — ${count} tiles running`;
      return ctx.spawnAgent?.(kind, cwd) ?? 'error: spawn unavailable';
    },
  },
  {
    name: 'set_goal',
    description:
      'Set a new watchdog goal (replaces the current one and re-arms the loop) or clear it by omitting text. You are authorized to set goals when the situation calls for it — formalize what the loop is working toward.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the new goal (omit or empty to clear)' },
      },
    },
    async run(args, ctx) {
      if (!ctx.setGoal) return 'error: set_goal unavailable';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      await ctx.setGoal(text.length > 0 ? text : '');
      return text.length > 0 ? `goal set: ${sanitizeChatText(text)}` : 'goal cleared';
    },
  },
  {
    name: 'open_test_page',
    description:
      "Open a URL in the Test tab — the embedded mini browser for exercising webapp results (an agent's dev server, a built artifact). The Test tab switches into view for the user. Use it when an agent reports a working server or page.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'the URL to open (http/https; localhost allowed)' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (url.length === 0) return 'error: url required';
      return ctx.openTestPage?.(url) ?? 'error: test tab unavailable';
    },
  },
  {
    name: 'read_test_page',
    description:
      "Read the Test tab's state: URL, title, loading flag, console-error count and the last 20 console messages (levels + text). Use it to verify a page loaded cleanly and to debug failures after a fix.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return ctx.readTestPage?.() ?? 'error: test tab unavailable';
    },
  },
  {
    name: 'screenshot_test_page',
    description:
      "Save a PNG screenshot of the Test tab's current page under the session's reviewer/shots directory FOR THE USER. You cannot see images — prefer read_test_page for verification.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return ctx.screenshotTestPage?.() ?? 'error: test tab unavailable';
    },
  },
  {
    name: 'run_bash',
    description:
      "Run a quick shell command in the session project (or an agent's cwd). Output capped at 64 KiB. timeout is 1-300s (default 30). For anything longer or long-running servers, use run_background + job_status instead.",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command to run' },
        cwd: { type: 'string', description: 'working directory (defaults to the project root)' },
        timeout: { type: 'number', description: 'seconds before the command is killed (1–300, default 30)' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command) return 'error: command required';
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd;
      const timeoutSec = clampInt(args.timeout, 30, 1, 300);
      return runShell(command, cwd, timeoutSec * 1000);
    },
  },
  {
    name: 'list_dir',
    description:
      'List a directory: directories first (trailing slash), then files with sizes. depth 1-3 (default 1), hidden entries skipped unless asked, node_modules/.git/dist-like dirs skipped. Browse the project before judging agent work.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'directory (defaults to the project root)' },
        depth: { type: 'number', description: 'recursion depth (1–3, default 1)' },
        includeHidden: { type: 'boolean', description: 'include dotfiles/dot-directories' },
      },
    },
    async run(args, ctx) {
      const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : '';
      const abs = path.startsWith('/') ? path : join(ctx.cwd, path);
      const depth = clampInt(args.depth, 1, 1, 3);
      const includeHidden = args.includeHidden === true;
      return listDir(abs, depth, includeHidden);
    },
  },
  {
    name: 'search_files',
    description:
      'Search the project for lines matching a regex (e.g. stubs, TODOs, wrong symbols) — returns path:line: text, capped. Use it to verify an agent actually implemented something and did not leave placeholders.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to match against each line' },
        path: { type: 'string', description: 'directory to search (defaults to the project root)' },
        glob: { type: 'string', description: 'file-name filter, e.g. "*.tsx" or "*.{ts,tsx}" (* wildcard only)' },
        maxMatches: { type: 'number', description: 'maximum hits (default 100)' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      if (pattern.length === 0) return 'error: pattern required';
      const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : '';
      const abs = path.startsWith('/') ? path : join(ctx.cwd, path);
      const glob = typeof args.glob === 'string' && args.glob.trim().length > 0 ? args.glob.trim() : undefined;
      const maxMatches = clampInt(args.maxMatches, 100, 1, 500);
      return searchFiles(pattern, abs, glob, maxMatches);
    },
  },
  {
    name: 'run_background',
    description:
      'Start a long-running process in the background (dev servers, builds, test suites) and get a job id. Poll with job_status, stop with job_stop. Output ring 32 KiB, 4 jobs max, jobs die with the session. Prefer this over run_bash for anything slow.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command to run' },
        cwd: { type: 'string', description: 'working directory (defaults to the project root)' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command.length === 0) return 'error: command required';
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd;
      return ctx.runBackground?.(command, cwd) ?? 'error: background jobs unavailable';
    },
  },
  {
    name: 'job_status',
    description:
      "Read a background job's state (running/exited + exit code) and recent output. Poll it after run_background to know when a build or test finished.",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'the job id from run_background' } },
      required: ['jobId'],
    },
    async run(args, ctx) {
      const jobId = typeof args.jobId === 'string' ? args.jobId.trim() : '';
      if (jobId.length === 0) return 'error: jobId required';
      return ctx.jobStatus?.(jobId) ?? 'error: background jobs unavailable';
    },
  },
  {
    name: 'job_stop',
    description: 'Stop a background job started with run_background (SIGTERM, SIGKILL after 2s).',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'the job id from run_background' } },
      required: ['jobId'],
    },
    async run(args, ctx) {
      const jobId = typeof args.jobId === 'string' ? args.jobId.trim() : '';
      if (jobId.length === 0) return 'error: jobId required';
      return ctx.jobStop?.(jobId) ?? 'error: background jobs unavailable';
    },
  },
  {
    name: 'list_messages',
    description:
      "Read the session's mailbox log (tasks, results, notes routed between you and the agents) — filter by kind, limit to the last N. Use it to audit what was dispatched and returned.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'result', 'note'], description: 'only messages of this kind' },
        limit: { type: 'number', description: 'last N messages (default 50, max 200)' },
      },
    },
    async run(args, ctx) {
      const kind = args.kind === 'task' || args.kind === 'result' || args.kind === 'note' ? args.kind : null;
      const limit = clampInt(args.limit, 50, 1, 200);
      const all = await ctx.listMessages?.();
      if (!all) return 'error: message log unavailable';
      const rows = all
        .filter((m) => kind === null || m.kind === kind)
        .slice(-limit)
        .map((m) => ({
          from: m.from,
          to: m.to,
          kind: m.kind,
          at: new Date(m.at).toISOString(),
          body: sanitizeChatText(m.body).slice(0, 300),
        }));
      return rows.length > 0 ? JSON.stringify(rows, null, 2) : '(no messages)';
    },
  },
  {
    name: 'launch_agent',
    description:
      "Run a command inside an EXISTING agent's terminal — e.g. launch an agent harness like opencode in a shell tile — without spawning a new tile. Its output lands in the tile recording (read with read_tile). For a brand-new tile use spawn_agent.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'the agent\'s tile to type into (from list_tiles)' },
        command: { type: 'string', description: 'the command to run inside the tile' },
      },
      required: ['agentId', 'command'],
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (agentId.length === 0 || command.length === 0) return 'error: agentId and command required';
      return ctx.writeToAgent?.(agentId, command) ?? 'error: launch unavailable';
    },
  },
  {
    name: 'send_keystroke',
    description:
      "Send key presses into an agent's terminal, like the user pressing keys. Named combos: shift-tab (opencode plan/build toggle), tab, enter, escape, ctrl-c, up, down, left, right. Any other string is sent literally. Verify the effect with read_tile afterwards.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'the agent whose tile receives the keys' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'named combos (shift-tab, enter, escape, ctrl-c, arrows) or literal text, in order',
        },
      },
      required: ['agentId', 'keys'],
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
      const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === 'string') : [];
      if (agentId.length === 0 || keys.length === 0) return 'error: agentId and at least one key required';
      const bytes = keys.map((k) => KEY_ESCAPES[k] ?? k).join('');
      const result = await ctx.writeToAgent?.(agentId, bytes);
      return result ?? `error: unknown agent ${agentId}`;
    },
  },
  {
    name: 'type_into_tile',
    description:
      "Type raw text (an answer, 'yes', a command) into an agent's terminal — the safe-yolo way to answer a question the agent asked inside its own harness (e.g. an opencode permission prompt). Optionally presses Enter. Never leaves input unverified: read_tile afterwards to see the effect.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'the agent whose terminal receives the text' },
        text: { type: 'string', description: 'the exact characters to type (sent verbatim)' },
        pressEnter: { type: 'boolean', description: 'whether to press Enter after the text (default false)' },
      },
      required: ['agentId', 'text'],
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
      const text = typeof args.text === 'string' ? args.text : '';
      if (agentId.length === 0 || text.length === 0) return 'error: agentId and text required';
      const withEnter = args.pressEnter === true ? '\r' : '';
      const result = await ctx.writeToAgent?.(agentId, `${text}${withEnter}`);
      return result ?? `error: unknown agent ${agentId}`;
    },
  },
  {
    name: 'reload_test_page',
    description:
      "Reload the Test tab's current page. Use it after a fix: reload, then read_test_page to verify the console is clean.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      return ctx.reloadTestPage?.() ?? 'error: test tab unavailable';
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the project (or an absolute path), up to 4 MiB. For browsing use list_dir; for finding code use search_files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'directory to search (defaults to the project root)' },
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

/** Directories that are never worth browsing or searching. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.cache', 'target', '.venv', 'venv', '__pycache__', '.next', '.turbo',
]);

const LIST_ENTRY_CAP = 500;
const SEARCH_SCAN_CAP = 5_000;
const SEARCH_LINE_CAP = 200;

async function listDir(abs: string, depth: number, includeHidden: boolean): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: string, remaining: number): Promise<void> => {
    if (out.length >= LIST_ENTRY_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      out.push(`error: ${(err as NodeJS.ErrnoException).message}`);
      return;
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    );
    for (const e of entries) {
      if (out.length >= LIST_ENTRY_CAP) {
        out.push('…[entry cap reached]');
        return;
      }
      if (!includeHidden && e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      const rel = relative(abs, full);
      if (e.isDirectory()) {
        if (remaining > 1 && SKIP_DIRS.has(e.name)) continue;
        out.push(`${rel}/`);
        if (remaining > 1) await walk(full, remaining - 1);
      } else {
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          continue; // broken symlink or unreadable
        }
        out.push(`${rel} (${size} B)`);
      }
    }
  };
  await walk(abs, Math.max(1, Math.min(3, depth)));
  return out.length > 0 ? out.join('\n') : '(empty)';
}

async function searchFiles(
  pattern: string,
  abs: string,
  glob: string | undefined,
  maxMatches: number,
): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `error: bad regex: ${String(err)}`;
  }
  const fileRe = glob !== undefined ? new RegExp(globToRe(glob)) : null;
  const hits: string[] = [];
  let scanned = 0;
  const walk = async (dir: string, remaining: number): Promise<void> => {
    if (hits.length >= maxMatches || scanned >= SEARCH_SCAN_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxMatches || scanned >= SEARCH_SCAN_CAP) return;
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (remaining > 1 && SKIP_DIRS.has(e.name)) continue;
        if (remaining > 1) await walk(full, remaining - 1);
      } else {
        if (fileRe && !fileRe.test(e.name)) continue;
        scanned += 1;
        try {
          const st = await stat(full);
          if (st.size > 2 * 1024 * 1024) continue; // skip big/binary files
          const content = await readFile(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
            if (re.test(lines[i]!)) {
              hits.push(`${relative(abs, full)}:${i + 1}: ${lines[i]!.slice(0, SEARCH_LINE_CAP)}`);
            }
          }
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  await walk(abs, 12);
  if (hits.length === 0) return '(no matches)';
  const note = scanned >= SEARCH_SCAN_CAP ? '\n…[scan cap reached]' : '';
  return `${capResult(hits.join('\n'))}${note}`;
}

function globToRe(glob: string): string {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') {
      out += '.*';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return `${out}$`;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/bash',
      ['-lc', command],
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 + 4096, env: { ...process.env, PWD: cwd } },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.trim();
        if (err) {
          const killed = (err as { killed?: boolean }).killed === true;
          const kind = killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message;
          resolve(out.length > 0 ? `error: ${kind}\n${out}` : `error: ${kind}`);
          return;
        }
        resolve(out.length > 0 ? out : '(no output)');
      },
    );
    void child;
  });
}
