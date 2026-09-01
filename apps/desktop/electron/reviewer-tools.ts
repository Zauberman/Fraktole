import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { FraktoleMessage, ReviewerQuestion, ReviewerState, ReviewerTask } from '../src/shared/ipc.js';
import { sanitizeChatText } from '../src/shared/sanitize.js';
import { commandIsPlainLaunch, effectiveAllowlist, launcherFirstToken } from '../src/shared/launchers.js';
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
  /** Spawn an agent tile; main allocates the id and mounts it in the UI.
   *  userPicked=true marks a launcher the USER chose (ask_user answer /
   *  remembered ledger pick) — it skips the allowlist but never the
   *  plain-command check. */
  spawnAgent?(kind: string, cwd: string, opts?: { userPicked?: boolean }): Promise<string>;
  /** Live agent tile count (spawn cap). */
  agentCount?(): number;
  /** The configured launcher command ('' = none). */
  getAgentCommand?(): string;
  /** Set or clear the loop carrier goal (user-authorized: always allowed). The
   *  model may also subdivide the CURRENT goal into sub-goals. */
  setGoal?(text: string, subGoals?: Array<{ text: string; done: boolean }>): Promise<void>;
  /** The mailbox message log for the session. */
  listMessages?(): Promise<FraktoleMessage[]>;
  /** Write into an existing agent's terminal (launch_agent, send_keystroke,
   *  type_into_tile). raw=true sends the bytes verbatim — no trailing newline
   *  is appended (keystrokes and typed answers press their own keys). */
  writeToAgent?(agentId: string, command: string, opts?: { raw?: boolean }): Promise<string>;
  /** True only for tiles running a harness launcher (kind === 'agent'); a bare
   *  shell tile is never a valid target for terminal input. */
  isHarnessTile?(tileId: string): boolean;
  /** The user's extra allowed launchers (settings); extends the built-in
   *  defaults — gates spawn_agent and terminal input into shell tiles. */
  getAllowedLaunchers?(): Promise<string[]>;
  /** Every agent tile in the session (including silent ones with no output
   *  yet) — list_tiles merges this with the live recording stats. */
  listAgents?(): Array<{ agentId: string; cwd: string | null }>;
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

/** Upper bound for the bytes typed into an agent's terminal in one call —
 *  the model must not be able to flood a live PTY. */
const TERMINAL_INPUT_CAP = 10_000;

/** ReDoS guard: nested-quantifier patterns (e.g. (a+)+) are the classic
 *  catastrophic-backtracking signature — reject them outright. */
const RE_UNSAFE = /\([^()]*[+*?][^()]*\)[+*?]/;
/** Line length fed to a model-supplied regex (search_files); longer lines
 *  are truncated for the test only. */
const SEARCH_LINE_TEST_CAP = 4096;

export function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n...[truncated]`;
}

/** Shown when a resolved tile has no live recording yet (e.g. the recorder
 *  started empty after a restart) — never a silent "(empty)". */
function noLiveHint(): string {
  return 'no live recording yet — use read_scrollback for the persisted history';
}

/** Terminal-input tools (type_into_tile, send_keystroke, launch_agent) may
 *  freely target a tile running a harness launcher. A bare shell tile accepts
 *  ONLY the command that starts an allowlisted launcher (plain invocation, no
 *  shell metacharacters) — anything else would execute as arbitrary shell
 *  commands, the path where the orchestrator "does the work itself" instead of
 *  delegating. Returns an error string, or null when the input is allowed. */
async function terminalInputGuard(agentId: string, ctx: ReviewerToolContext, input?: string): Promise<string | null> {
  const id = agentId.trim();
  const tileId = ctx.tileOfAgent?.(id);
  if (!tileId) return `error: unknown agent ${id || '(empty)'}`;
  if (ctx.isHarnessTile?.(tileId)) return null;
  const cmd = typeof input === 'string' ? input.trim() : '';
  if (
    cmd.length > 0 &&
    commandIsPlainLaunch(cmd) &&
    effectiveAllowlist(await ctx.getAllowedLaunchers?.(), ctx.getAgentCommand?.()).includes(launcherFirstToken(cmd))
  ) {
    return null;
  }
  return 'error: only allowlisted launchers (e.g. opencode) may be started in a shell tile — delegate work with send_message or spawn_agent';
}

/** The slice of ReviewerToolContext the launcher gate needs — lets host-side
 *  callers (spawnAgentInSession) reuse the exact same rule. */
export interface LauncherGateContext {
  getAllowedLaunchers?(): Promise<string[]>;
  /** May be sync (reviewer memory) or async (settings read). */
  getAgentCommand?(): string | Promise<string>;
}

/** spawn_agent's kind is typed into a fresh shell as a command — validate it
 *  exactly like terminal input into a shell tile ('shell' = plain shell).
 *  Exported so the host-side spawn path (spawnAgentInSession) enforces the
 *  same rule as the tool: the remote agent.spawn RPC funnels through there. */
export async function validateLauncherKind(kind: string, ctx: LauncherGateContext): Promise<string | null> {
  if (kind === 'shell') return null;
  const allowed =
    commandIsPlainLaunch(kind) &&
    effectiveAllowlist(await ctx.getAllowedLaunchers?.(), await ctx.getAgentCommand?.()).includes(launcherFirstToken(kind));
  return allowed
    ? null
    : 'error: unknown launcher — use one from the allowed launchers (e.g. opencode or shell), or ask the user with ask_user (kind agent-kind)';
}

const TOOLS: ReviewerTool[] = [
  {
    name: 'list_tiles',
    description: 'List every agent tile: agent id, tile id, working dir, recorded line count, and seconds since the tile last produced output (dead-tile detection). Call this FIRST at the start of an engagement.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const now = Date.now();
      const stats = new Map<string, { lines: number; lastAt: number }>();
      for (const [tileId, summary] of ctx.recorder.list().entries()) {
        const agentId = ctx.agentOfTile(tileId) ?? tileId;
        stats.set(agentId, summary);
      }
      const row = (agentId: string, s?: { lines: number; lastAt: number }): Record<string, unknown> => ({
        tileId: ctx.tileOfAgent(agentId) ?? null,
        agentId,
        cwd: ctx.cwdOfAgent(agentId),
        lines: s?.lines ?? 0,
        lastActiveAgoSec: s ? Math.max(0, Math.round((now - s.lastAt) / 1000)) : null,
      });
      // every session agent, even one that just spawned and has not printed
      // anything yet — a silent tile is a fact the reviewer must see
      const agents = ctx.listAgents?.() ?? [];
      const rows = agents.map((a) => row(a.agentId, stats.get(a.agentId)));
      for (const [agentId, s] of stats) {
        if (!agents.some((a) => a.agentId === agentId)) rows.push(row(agentId, s));
      }
      if (rows.length === 0) return 'no tiles recorded yet';
      return JSON.stringify(rows, null, 2);
    },
  },
  {
    name: 'read_tile',
    description:
      'Read the live recording of an agent tile: the last `tail` lines, lines matching `grep`, or the ENTIRE recording with `full`. Put the agent id in `agentId` (a tile id in `tileId` also works). Unknown tiles error; when no live output is recorded yet (e.g. right after a restart) use read_scrollback for the persisted history.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
        tileId: { type: 'string', description: 'tile id (from list_tiles); agentId also works' },
        tail: { type: 'number', description: 'last N lines to return (default 40)' },
        grep: { type: 'string', description: 'return only lines matching this regex' },
        full: { type: 'boolean', description: 'true returns the entire recorded output (not just a tail)' },
      },
    },
    async run(args, ctx) {
      const tileId = resolveTile(args, ctx);
      if (!tileId) return 'error: unknown tile or agent — call list_tiles first';
      // a resolved tile with no live data yet (e.g. the recorder started empty
      // after an app restart) must never read as a silent "(empty)" — steer
      // the model to the persisted history instead
      if (args.full === true) {
        const lines = ctx.recorder.full(tileId);
        if (lines.length === 0) return noLiveHint();
        return capResult(lines.join('\n'));
      }
      if (typeof args.grep === 'string' && args.grep.length > 0) {
        if (RE_UNSAFE.test(args.grep)) return 'error: bad grep regex: unsafe pattern (nested quantifiers)';
        let re: RegExp;
        try {
          re = new RegExp(args.grep);
        } catch (err) {
          return `error: bad grep regex: ${String(err)}`;
        }
        if (!ctx.recorder.has(tileId)) return noLiveHint();
        return capResult(ctx.recorder.search(tileId, re).join('\n') || '(no matches)');
      }
      const n = clampInt(args.tail, 40, 1, 500);
      const lines = ctx.recorder.tail(tileId, n);
      if (lines.length === 0) return noLiveHint();
      return capResult(lines.join('\n'));
    },
  },
  {
    name: 'read_scrollback',
    description: "Read an agent's full output history — the zero-lag complement to read_tile when its tail is not enough. While the agent runs, this reads its live recording (a real terminal emulation: full-screen TUIs like opencode render as clean lines); otherwise it reads the on-disk capture (fresh within ~1s). Up to 5000 lines. Use it to judge a completed piece of work.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'agent id (from list_tiles)' },
        tail: { type: 'number', description: 'last N lines (default 200, max 5000)' },
      },
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === 'string' ? args.agentId : '';
      if (!agentId) return 'error: agentId required';
      // agent ids are internally generated agent-<n> — reject anything else
      // before it ever reaches a path join (same rule as the spawn host)
      if (!/^agent-\d+$/.test(agentId)) return 'error: invalid agentId';
      const n = clampInt(args.tail, 200, 1, 5000);
      // while the agent runs, its live recording is the freshest view (zero
      // lag) — use it directly and never fall back to a save-time snapshot
      const tileId = ctx.tileOfAgent(agentId);
      if (tileId && ctx.recorder.has(tileId)) {
        const lines = ctx.recorder.tail(tileId, n);
        return capResult(lines.join('\n') || noLiveHint());
      }
      // never let a model-supplied id escape the session's scrollback dir
      // (read_file allows absolute paths on purpose — this tool does not)
      const scrollbackRoot = join(ctx.sessionDir, 'scrollback');
      const abs = join(scrollbackRoot, `${agentId}.json`);
      const rel = relative(scrollbackRoot, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return 'error: invalid agentId';
      }
      let raw: string;
      try {
        raw = await readFile(abs, 'utf8');
      } catch {
        return 'error: no scrollback for this agent yet';
      }
      let lines: string[];
      try {
        lines = (JSON.parse(raw) as { lines: string[] }).lines ?? [];
      } catch {
        return 'error: corrupt scrollback file';
      }
      return capResult(lines.slice(-n).join('\n') || '(empty)');
    },
  },
  {
    name: 'send_message',
    description:
      'Send a task or note to an agent. Tasks get results back through the mailboxes and wake you; notes are informational. This is the PRIMARY way substantive work gets done — dispatch implementation to agents instead of doing it yourself; always state precise, verifiable acceptance criteria in the body. Prefer it over doing the work yourself when an agent owns the area. The body is echoed into the agent\'s terminal and stored in its inbox: only send to a tile that is running its harness at its prompt (not a bare shell) — a body typed into a bare shell executes as shell commands.',
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
    description: 'Return the current goal and task ledger (the durable loop carrier state). Check it when you need to recall what was assigned, to whom, and in what state.',
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
      'Kill an agent tile (terminates its PTY and closes the tile). Always allowed — no confirmation needed. The user may also kill directly with /kill. Never target the orchestrator.',
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
      "Spawn a NEW agent tile (a shell in cwd with the launch command written into it). Fire agents for implementation work whenever the workforce is idle or too small. Fire a known kind directly (the ledger remembers the user's choice) or omit kind to let the user pick. Capped at 8 agents. Only ALLOWED launchers are accepted as a kind ('shell' = a plain shell tile); anything else is rejected — use ask_user (kind agent-kind) to get the user's pick. To run a harness inside an EXISTING tile instead, use launch_agent.",
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
      let asked = false;
      if (kind.length === 0) {
        if (!ctx.askUser) return 'error: no agent kind — ask the user which agent to spawn';
        kind = (await ctx.askUser('which agent should I spawn? (opencode, shell, or a launcher command)', 'agent-kind')).trim();
        if (/^(skipped?|skip)$/i.test(kind)) return 'error: spawn cancelled by the user';
        asked = true;
      }
      if (kind.length === 0) return 'error: no agent kind';
      // a launcher the USER picked (ask_user answer, or the ledger's
      // remembered pick) is authorized by consent — the allowlist does not
      // apply to it, but the plain-command check always does
      const userPicked = asked || kind === ctx.getState?.().lastAgentKind;
      if (!userPicked) {
        const kindErr = await validateLauncherKind(kind, ctx);
        if (kindErr) return kindErr;
      } else if (!commandIsPlainLaunch(kind)) {
        return 'error: launcher command is not a plain invocation (no shell metacharacters)';
      }
      const count = ctx.agentCount?.() ?? 0;
      if (count >= 8) return `error: agent cap (8) reached — ${count} tiles running`;
      return ctx.spawnAgent?.(kind, cwd, { userPicked }) ?? 'error: spawn unavailable';
    },
  },
  {
    name: 'set_goal',
    description:
      'Set a new loop carrier goal (replaces the current one and re-arms the loop), clear it by omitting text, or subdivide the CURRENT goal into sub-goals with subGoals. You are authorized to set goals when the situation calls for it — when a big goal is armed, break it into smaller sub-goals with subGoals and keep the list current as you complete items.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the new top-level goal (omit to keep the current one when only sub-goals change; empty clears the goal)' },
        subGoals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'one sub-goal' },
              done: { type: 'boolean', description: 'true when this sub-goal is completed' },
            },
            required: ['text'],
          },
          description: 'the full current sub-goal list (replaces it; requires an active goal)',
        },
      },
    },
    async run(args, ctx) {
      if (!ctx.setGoal) return 'error: set_goal unavailable';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      const rawSubs = Array.isArray(args.subGoals) ? args.subGoals : [];
      const subGoals = rawSubs
        .filter((s): s is { text?: unknown; done?: unknown } => typeof s === 'object' && s !== null)
        .map((s) => ({ text: typeof s.text === 'string' ? s.text.trim() : '', done: s.done === true }))
        .filter((s) => s.text.length > 0);
      await ctx.setGoal(text.length > 0 ? text : '', subGoals.length > 0 ? subGoals : undefined);
      if (subGoals.length > 0) return `sub-goals set: ${subGoals.map((s) => s.text).join(' | ')}`;
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
    name: 'list_dir',
    description:
      'List a directory: directories first (trailing slash), then files with sizes. depth 1-3 (default 1), hidden entries skipped unless asked, node_modules/.git/dist-like dirs skipped. Use freely to understand and verify the codebase yourself before judging agent work; for finding code use search_files.',
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
      'Search for lines matching a regex (e.g. stubs, TODOs, wrong symbols) — returns path:line: text, capped. `path` may be a single FILE or a directory to walk; a missing path errors. Use freely to verify an agent actually implemented something and did not leave placeholders.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to match against each line' },
        path: { type: 'string', description: 'a file to search, or a directory to walk (defaults to the project root)' },
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
      return searchFiles(pattern, abs, glob, maxMatches, path);
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
      return rows.length > 0 ? JSON.stringify(rows, null, 2) : '(no messages yet — tasks you dispatch with send_message appear here)';
    },
  },
  {
    name: 'launch_agent',
    description:
      "Run a command inside an EXISTING agent's terminal. In a HARNESS tile (running a launcher like opencode) any command is accepted. In a bare SHELL tile only an allowed launcher (e.g. opencode, a plain program invocation with no shell metacharacters) may be started — arbitrary shell commands are rejected there; delegate work with send_message or spawn_agent instead. Its output lands in the tile recording (read with read_tile). For a brand-new tile use spawn_agent.",
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
      if (command.length > TERMINAL_INPUT_CAP) return `error: command too large (${command.length} chars, cap ${TERMINAL_INPUT_CAP})`;
      const err = await terminalInputGuard(agentId, ctx, command);
      if (err) return err;
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
      if (bytes.length > TERMINAL_INPUT_CAP) return `error: keystrokes too large (${bytes.length} chars, cap ${TERMINAL_INPUT_CAP})`;
      const err = await terminalInputGuard(agentId, ctx, bytes);
      if (err) return err;
      const result = await ctx.writeToAgent?.(agentId, bytes, { raw: true });
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
      if (text.length > TERMINAL_INPUT_CAP) return `error: text too large (${text.length} chars, cap ${TERMINAL_INPUT_CAP})`;
      const err = await terminalInputGuard(agentId, ctx, text);
      if (err) return err;
      const withEnter = args.pressEnter === true ? '\r' : '';
      const result = await ctx.writeToAgent?.(agentId, `${text}${withEnter}`, { raw: true });
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
    description:
      'Read one or more files from the project (or absolute paths), up to 4 MiB each. Pass paths to read several related files in one call. Use freely to grasp the codebase yourself. For browsing use list_dir; for finding code use search_files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'single file to read (or use paths for several)' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'several files to read in one call (each capped at 4 MiB)',
        },
      },
      anyOf: [{ required: ['path'] }, { required: ['paths'] }],
    },
    async run(args, ctx) {
      const single = typeof args.path === 'string' && args.path.length > 0 ? args.path : null;
      const list = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : [];
      const targets = single ? [single] : list;
      if (targets.length === 0) return 'error: path or paths required';
      if (targets.length > 8) return 'error: at most 8 files per call';
      const out: string[] = [];
      for (const path of targets) {
        const abs = path.startsWith('/') ? path : join(ctx.cwd, path);
        try {
          // size-check BEFORE reading: a huge file must never be buffered
          // into the main process just to be rejected
          const st = await stat(abs);
          if (st.size > 4 * 1024 * 1024) {
            out.push(`=== ${path} ===\nerror: file larger than 4 MiB`);
            continue;
          }
          const content = await readFile(abs, 'utf8');
          out.push(targets.length === 1 ? content : `=== ${path} ===\n${content}`);
        } catch (err) {
          out.push(`=== ${path} ===\nerror: ${(err as NodeJS.ErrnoException).message}`);
        }
      }
      return out.join('\n\n');
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
  if (typeof args.tileId === 'string' && args.tileId.length > 0) {
    // the model may pass an AGENT id in the tileId field (list_tiles shows
    // both) — never silently resolve to an unknown key; fall back to the
    // agent→tile mapping before giving up
    if (ctx.recorder.has(args.tileId)) return args.tileId;
    return ctx.agentOfTile(args.tileId);
  }
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
        out.push('...[entry cap reached]');
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
  display: string,
): Promise<string> {
  if (RE_UNSAFE.test(pattern)) return 'error: bad regex: unsafe pattern (nested quantifiers)';
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `error: bad regex: ${String(err)}`;
  }
  // stat first: a FILE path must search that single file (never silently
  // match nothing), and a missing path must error loudly instead of reading
  // as a false "(no matches)"
  let st;
  try {
    st = await stat(abs);
  } catch {
    return `error: path not found: ${display}`;
  }
  if (st.isFile()) return searchSingleFile(re, abs, display, maxMatches);
  if (!st.isDirectory()) return `error: path is not a file or directory: ${display}`;
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
            const line = lines[i]!;
            // test a capped slice: a pathological pattern against a huge
            // single line must not hang the main process
            if (re.test(line.slice(0, SEARCH_LINE_TEST_CAP))) {
              hits.push(`${relative(abs, full)}:${i + 1}: ${line.slice(0, SEARCH_LINE_CAP)}`);
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

/** Searches a single file (search_files given a file path). Hits are prefixed
 *  with the caller's `display` path so the model can map them back. */
async function searchSingleFile(
  re: RegExp,
  file: string,
  display: string,
  maxMatches: number,
): Promise<string> {
  try {
    const st = await stat(file);
    if (st.size > 2 * 1024 * 1024) return 'error: file larger than 2 MiB — use read_file';
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    const hits: string[] = [];
    for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
      const line = lines[i]!;
      if (re.test(line.slice(0, SEARCH_LINE_TEST_CAP))) {
        hits.push(`${display}:${i + 1}: ${line.slice(0, SEARCH_LINE_CAP)}`);
      }
    }
    if (hits.length === 0) return '(no matches)';
    return capResult(hits.join('\n'));
  } catch (err) {
    return `error: ${(err as NodeJS.ErrnoException).message}`;
  }
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

