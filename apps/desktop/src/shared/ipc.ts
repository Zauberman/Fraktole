import type { AutonomyVariant } from './autonomy.js';

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
  themeApply: 'theme:apply',
  sessionsList: 'sessions:list',
  sessionNew: 'session:new',
  sessionSaveAs: 'session:save-as',
  sessionSave: 'session:save',
  sessionOpen: 'session:open',
  sessionDelete: 'session:delete',
  sessionStop: 'session:stop',
  sessionStart: 'session:start',
  sessionExportBundle: 'session:export-bundle',
  sessionImportBundle: 'session:import-bundle',
  projectOpen: 'project:open',
  projectsFiles: 'projects:files',
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
  reviewerUsage: 'reviewer:usage',
  reviewerAutonomy: 'reviewer:autonomy',
  reviewerSummarize: 'reviewer:summarize',
  reviewerResumable: 'reviewer:resumable',
  reviewerRecap: 'reviewer:recap',
  reviewerBudget: 'reviewer:budget',
  reviewerToolCall: 'reviewer:tool-call',
  reviewerMessage: 'reviewer:message',
  menuSession: 'menu:session',
  menuHelp: 'menu:help',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  testOpen: 'test:open',
  testStateRequest: 'test:state-request',
  testState: 'test:state',
  testScreenshotRequest: 'test:screenshot-request',
  testScreenshot: 'test:screenshot',
  testReload: 'test:reload',
  remoteGetState: 'remote:get-state',
  remoteSetEnabled: 'remote:set-enabled',
  remoteSetPort: 'remote:set-port',
  remoteRevokeDevice: 'remote:revoke-device',
  remoteStatus: 'remote:status',
  menuSettings: 'menu:settings',
  settingsChanged: 'settings:changed',
  settingsRevealData: 'settings:reveal-data',
  fsWatchFile: 'fs:watch-file',
  fsUnwatchFile: 'fs:unwatch-file',
  fsFileChanged: 'fs:file-changed',
  fsMkdir: 'fs:mkdir',
  fsCreateFile: 'fs:create-file',
  fsRename: 'fs:rename',
  fsTrash: 'fs:trash',
  gitStatus: 'git:status',
  searchProject: 'search:project',
  usageHistory: 'usage:history',
} as const;

/** Sections of the in-app Settings view — the native Settings menu jumps to
 *  one of these, the palette can open any of them. */
export type SettingsSection =
  | 'general'
  | 'model'
  | 'sampling'
  | 'agents'
  | 'compose'
  | 'editor'
  | 'shortcuts'
  | 'usage'
  | 'advanced';

/** menu:settings payload — open the Settings view, optionally at a section. */
export interface MenuSettingsAction {
  section?: SettingsSection;
}

/** git:status result for a project root (null when not a git repo). */
export type GitMark = 'M' | 'A' | 'D' | 'R' | '?';

export interface GitStatus {
  branch: string | null;
  /** Path (relative to the project root) → change mark. */
  entries: Record<string, GitMark>;
}

/** One search hit in the project-search panel. */
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** search:project result. `engine` reports whether ripgrep or the JS
 *  fallback walk produced the hits. */
export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  engine: 'rg' | 'walk';
}

/** One per-turn token usage sample, appended to the session's usage log
 *  after each completed turn (deltas, not cumulative). */
export interface UsageSample {
  at: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface MenuSessionAction {
  action: 'new' | 'save-as' | 'rename' | 'open' | 'delete' | 'stop' | 'start' | 'export-bundle' | 'import-bundle';
  id?: string;
}

/** Result of exporting/importing a session bundle (tar.gz). `canceled` is
 *  set when the user dismissed the file dialog — the UI shows no error. */
export type BundleResult =
  | { ok: true; path?: string; session?: SessionFile }
  | { ok: false; canceled?: boolean; error: string };

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

/** Model-tuning knobs for the reviewer harness. Every field optional:
 *  unset = provider default (the field is not sent on the wire). Range
 *  validation lives in the settings whitelist (electron/settings.ts) —
 *  invalid values are dropped at load, never coerced. */
export interface SamplerKnobs {
  /** Context window in tokens. Wire: ollama options.num_ctx; budget: the
   *  harness compaction target for every provider (80% of this). */
  contextTokens?: number;
  /** Output cap in tokens — max_tokens (openai/anthropic) or ollama
   *  options.num_predict. */
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  /** ollama only (not a chat.completions field) */
  topK?: number;
  /** ollama only */
  minP?: number;
  seed?: number;
  /** ollama only */
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** ollama only — body.keep_alive (e.g. "5m", "0" = unload) */
  keepAlive?: string;
  /** ollama only — body.think (force/disable thinking; false is safe on
   *  any model, true only on thinking-capable ones) */
  think?: boolean;
}

export interface Settings {
  theme: string;
  /** File-editor preferences (defaults filled by the store on read). */
  editor?: EditorSettings;
  /** Desktop-notification preferences. */
  notifications?: NotificationSettings;
  /** Explorer sidebar preferences. */
  explorer?: ExplorerSettings;
  /** The reviewer harness model config. Everything except the key is
   *  derived by resolveProvider: the key alone decides provider/endpoint,
   *  with optional explicit overrides for ambiguous sk- keys. */
  reviewer: {
    /** Pasted API key (stored in settings.json like opencode's auth.json). */
    apiKey?: string;
    /** Env-var fallback when apiKey is empty. */
    apiKeyEnv?: string;
    /** The manual provider pick (provider-catalog.ts id) — wins over the
     *  key-prefix detection when set. */
    providerId?: string;
    /** Explicit pick for ambiguous sk- keys ('deepseek' routes through the
     *  OpenAI adapter to api.deepseek.com). Superseded by providerId. */
    provider?: 'openai' | 'anthropic' | 'ollama' | 'deepseek';
    /** User's model pick; empty → per-provider default. */
    model?: string;
  /** Custom OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Launcher command for reviewer-spawned agent tiles (e.g. "opencode");
   *  empty = the model asks the user which agent to spawn. */
  agentCommand?: string;
  /** Extra launchers the reviewer may start in a shell tile (beyond the
   *  built-in defaults); anything else is rejected by spawn/terminal gating. */
  allowedLaunchers?: string[];
  /** Reasoning effort for models that support it (deepseek/openai).
   *  Unset = auto: 'high' on official DeepSeek/OpenAI endpoints, omitted
   *  elsewhere (custom endpoints can reject unknown params). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Model-tuning knobs; every field validated and optional (see
   *  SamplerKnobs). Unset = provider default, nothing sent on the wire. */
  knobs?: SamplerKnobs;
  /** The user's custom autonomous loop: name + full directive. When the
   *  custom variant is picked, this prompt replaces the placeholder. */
  customAutonomy?: { name?: string; prompt?: string };
  };
}

/** File-editor preferences. Always present after settings:get (defaults
 *  filled by the store); fontSize unset = CodeMirror default size. */
export interface EditorSettings {
  fontSize?: number;
  wrap: boolean;
  autoSave: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
}

export interface ExplorerSettings {
  hideHidden: boolean;
}

/** The harness reviewer's lifecycle status. */
export type ReviewerStatus = 'offline' | 'running' | 'idle' | 'stopped' | 'error' | 'unconfigured';

/** Live state of the Test tab's guest page, for read_test_page. */
export interface TestPageState {
  url: string;
  title: string;
  loading: boolean;
  /** count of console errors since the last navigation */
  consoleErrors: number;
  /** last console messages since the last navigation (level 0-3) */
  console: Array<{ level: number; message: string }>;
}

/** The loop carrier goal the user arms with /goal. Only the user sets it; the
 *  harness flips it to 'met' when the model declares GOAL-MET. */
export interface ReviewerGoal {
  text: string;
  setAt: number;
  state: 'active' | 'met';
}

/** One sub-goal of the armed loop carrier goal, set by the model via set_goal.
 *  The model keeps the list current as it completes items; the harness
 *  marks every sub-goal done when GOAL-MET is declared. */
export interface SubGoal {
  id: string;
  text: string;
  state: 'pending' | 'done';
}

/** One row of the durable task ledger (state.json). */
export interface ReviewerTask {
  id: string;
  agentId: string | null;
  title: string;
  status: 'pending' | 'active' | 'done' | 'failed';
  updatedAt: number;
}

/** Cumulative reviewer token usage, persisted in state.json. */
export interface ReviewerUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** Durable loop carrier state: the goal + its sub-goals + the task ledger.
 *  Persisted as sessionDir/reviewer/state.json — survives compaction and
 *  restarts. */
export interface ReviewerState {
  goal: ReviewerGoal | null;
  /** The model's subdivision of the armed goal (empty until set). */
  subGoals: SubGoal[];
  tasks: ReviewerTask[];
  /** The last agent launcher the user picked for a reviewer spawn — the
   *  model may reuse it without asking again. */
  lastAgentKind: string | null;
  /** The active autonomous-mode variant (null = normal mode). */
  variant: AutonomyVariant | null;
  /** Cumulative model token usage (input / cache-hit / output). */
  usage: ReviewerUsage;
  /** The last manual "summarize session" recap, if any. Survives restarts
   *  (persisted in state.json alongside the ledger). */
  recap?: { text: string; at: number } | null;
}

/** reviewer:usage event payload (cumulative totals). */
export interface ReviewerUsageEvent {
  at: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** reviewer:goal event payload. */
export interface ReviewerGoalEvent {
  goal: ReviewerGoal | null;
  subGoals: SubGoal[];
}

/** reviewer:recap event payload — the persisted session summary. */
export interface ReviewerRecapEvent {
  recap: { text: string; at: number };
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
  /** assistant only: the model's reasoning output (hidden by default). */
  thinking?: string;
  at: number;
}

/** reviewer:stream payload — content deltas and/or thinking deltas. */
export interface ReviewerStreamEvent {
  delta: string;
  thinking?: string;
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
  /** Launcher kind, persisted so a restored tile keeps its kind across
   *  restarts ('agent' = launcher command, 'shell' = plain shell). */
  kind?: 'agent' | 'shell';
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

/** One file in the quick-open palette: its basename and absolute path. */
export interface ProjectFile {
  name: string;
  path: string;
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

/** One paired phone, as shown in the Remote tab. */
export interface RemoteDeviceInfo {
  deviceId: string;
  name: string;
  connected: boolean;
  createdAt: number;
  lastSeen: number;
}

/** Live status of the remote bridge, pushed to the Remote tab. */
export interface RemoteStatus {
  enabled: boolean;
  /** Configured port (persisted). */
  port: number;
  /** True while the WSS server is actually listening. */
  listening: boolean;
  /** Last start failure message (null when all is well) — e.g. the port
   *  is taken by another process. */
  error: string | null;
  /** Self-signed cert SHA-256 fingerprint (hex, no separators). */
  fingerprint: string | null;
  /** LAN IPv4 addresses the phone can dial. */
  lanIps: string[];
  /** Current pairing code (null while disabled). */
  pairingCode: string | null;
  pairingCodeExpiresAt: number | null;
  devices: RemoteDeviceInfo[];
}
