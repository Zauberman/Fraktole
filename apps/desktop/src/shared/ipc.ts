export const IPC = {
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  tileExit: 'tile:exit',
  appInfo: 'app:info',
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  pickFolder: 'dialog:pick-folder',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  menuNewTile: 'menu:new-tile',
  menuTheme: 'menu:theme',
  sessionsList: 'sessions:list',
  sessionNew: 'session:new',
  sessionSaveAs: 'session:save-as',
  sessionSave: 'session:save',
  sessionOpen: 'session:open',
  sessionDelete: 'session:delete',
  sessionStop: 'session:stop',
  sessionStart: 'session:start',
  projectOpen: 'project:open',
  fsListDir: 'fs:list-dir',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsStat: 'fs:stat',
  messageSend: 'message:send',
  messageList: 'message:list',
  messageEvent: 'message:event',
  snapshotCreate: 'snapshot:create',
  snapshotGet: 'snapshot:get',
  scrollbackGet: 'scrollback:get',
  reviewerEnsure: 'reviewer:ensure',
  reviewerPrompt: 'reviewer:prompt',
  reviewerStop: 'reviewer:stop',
  reviewerRestart: 'reviewer:restart',
  reviewerCompact: 'reviewer:compact',
  reviewerSetGoal: 'reviewer:set-goal',
  reviewerGoal: 'reviewer:goal',
  reviewerListModels: 'reviewer:list-models',
  reviewerQuestion: 'reviewer:question',
  reviewerAnswer: 'reviewer:answer',
  reviewerKillNow: 'reviewer:kill-now',
  reviewerSpawnRequest: 'reviewer:spawn-request',
  reviewerSpawnResult: 'reviewer:spawn-result',
  reviewerTranscript: 'reviewer:transcript',
  reviewerStatus: 'reviewer:status',
  reviewerStream: 'reviewer:stream',
  reviewerToolCall: 'reviewer:tool-call',
  reviewerMessage: 'reviewer:message',
  menuSession: 'menu:session',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
} as const;

export interface MenuSessionAction {
  action: 'new' | 'save-as' | 'open' | 'delete' | 'stop' | 'start';
  id?: string;
}

export interface AppInfo {
  version: string;
  shell: string;
  userData: string;
  home: string;
}

export interface PtySpawnArgs {
  sessionId: string;
  tileId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Durable agent id. Omitted on live spawns (main allocates and registers
   *  one); provided on session restore so mailboxes stay intact. */
  agentId?: string;
  /** Launcher command written into the spawned shell (reviewer-spawned
   *  agent tiles). */
  command?: string;
}

export interface PtySpawnResult {
  agentId: string;
}

export interface PtyExitPayload {
  code: number | null;
}

export interface Project {
  path: string;
  name: string;
  lastUsed: number;
  /** The session bound to this project (1:1); opened with the project. */
  sessionId?: string;
}

export interface Settings {
  theme: string;
  /** The reviewer harness model config. Everything except the key is
   *  derived by resolveProvider: the key alone decides provider/endpoint,
   *  with optional explicit overrides for ambiguous sk- keys. */
  reviewer: {
    /** Pasted API key (stored in settings.json like opencode's auth.json). */
    apiKey?: string;
    /** Env-var fallback when apiKey is empty. */
    apiKeyEnv?: string;
    /** Explicit pick for ambiguous sk- keys ('deepseek' routes through the
     *  OpenAI adapter to api.deepseek.com). */
    provider?: 'openai' | 'anthropic' | 'ollama' | 'deepseek';
    /** User's model pick; empty → per-provider default. */
    model?: string;
  /** Custom OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Launcher command for reviewer-spawned agent tiles (e.g. "opencode");
   *  empty = the model asks the user which agent to spawn. */
  agentCommand?: string;
};
}

/** The harness reviewer's lifecycle status. */
export type ReviewerStatus = 'offline' | 'running' | 'idle' | 'stopped' | 'error' | 'unconfigured';

/** The watchdog goal the user arms with /goal. Only the user sets it; the
 *  harness flips it to 'met' when the model declares GOAL-MET. */
export interface ReviewerGoal {
  text: string;
  setAt: number;
  state: 'active' | 'met';
}

/** One row of the durable task ledger (state.json). */
export interface ReviewerTask {
  id: string;
  agentId: string | null;
  title: string;
  status: 'pending' | 'active' | 'done' | 'failed';
  updatedAt: number;
}

/** Durable watchdog state: the goal + the task ledger. Persisted as
 *  sessionDir/reviewer/state.json — survives compaction and restarts. */
export interface ReviewerState {
  goal: ReviewerGoal | null;
  tasks: ReviewerTask[];
  /** The last agent launcher the user picked for a reviewer spawn — the
   *  model may reuse it without asking again. */
  lastAgentKind: string | null;
}

/** reviewer:goal event payload. */
export interface ReviewerGoalEvent {
  goal: ReviewerGoal | null;
}

/** A pending ask_user question. The loop suspends until the user answers
 *  (reviewer:answer with the same askId) or skips. */
export interface ReviewerQuestion {
  askId: string;
  question: string;
  /** confirm-kill: yes/no buttons (a yes grants one kill of agentId);
   *  agent-kind: quick picks for the spawn launcher; free: plain input. */
  kind: 'free' | 'confirm-kill' | 'agent-kind';
  agentId?: string;
  at: number;
}

/** Main → renderer: the reviewer wants a new agent tile. The renderer adds
 *  it to its window tree with the pre-allocated agentId and reports back on
 *  reviewer:spawn-result. */
export interface ReviewerSpawnRequest {
  sessionId: string;
  requestId: string;
  agentId: string;
  cwd: string;
  /** Launcher command written into the shell ('' = plain shell). */
  command?: string;
}

export interface ReviewerEntry {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolCallId?: string;
  at: number;
}

export interface ReviewerToolCallEvent {
  /** Provider tool-call id — the renderer matches start→done/error cards. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  state: 'start' | 'done' | 'error';
  result?: string;
  error?: string;
  durationMs?: number;
  /** When the call started — lets the renderer interleave tool cards into
   *  the transcript timeline. */
  at: number;
}

/** Window-tree serialized with durable agent ids on the leaves. The live
 *  tree uses ephemeral tile ids; this shape is what session.json persists. */
export type SerNode =
  | { k: 'leaf'; agentId: string }
  | { k: 'split'; dir: 'h' | 'v'; ratio: number; a: SerNode; b: SerNode };

export interface SessionAgentMeta {
  agentId: string;
  cwd: string;
}

export interface SessionFile {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nextAgentSeq: number;
  judge: { command: string; cwd: string } | null;
  tree: SerNode | null;
  tiles: SessionAgentMeta[];
  zoomedAgentId?: string;
  focusedAgentId?: string;
  /** The project root this session belongs to (bound 1:1). */
  projectPath?: string;
}

export type SessionState = 'running' | 'idle' | 'stopped';

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: number;
  agentCount: number;
  projectPath?: string;
  /** Live runtime state, merged in by main (refresh via sessions:list). */
  state?: SessionState;
}

export interface OpenedSession {
  session: SessionFile;
  agents: SessionAgentMeta[];
  state: SessionState;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface FsStat {
  path: string;
  isDir: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

/** Mailbox message between the orchestrator and an agent. The same shape is
 *  the JSON file format in inbox/outbox dirs and one JSON line in
 *  messages.jsonl. */
export interface FraktoleMessage {
  id: string;
  from: string; // 'orchestrator' | agentId
  to: string; // 'orchestrator' | agentId
  kind: 'task' | 'result' | 'note';
  body: string;
  at: number;
  ref?: string; // snapshotId attached to a result
}

export interface SendMessageArgs {
  to: string;
  kind: FraktoleMessage['kind'];
  body: string;
  ref?: string;
}

export interface SessionSnapshot {
  id: string;
  agentId: string;
  at: number;
  lineCount: number;
  text: string;
}

/** Renderer → main on every save: the live arrangement serialized as agent
 *  ids, the live agent set (prunes the session's tile list), focus/zoom,
 *  the judge's working dir, and optional scrollback captures. */
export interface SessionSavePayload {
  tree: SerNode | null;
  agents: string[];
  zoomedAgentId?: string | null;
  focusedAgentId?: string | null;
  judgeCwd?: string | null;
  scrollback?: Record<string, string[]>;
}
