import type {
  AppInfo,
  BundleResult,
  FraktoleMessage,
  FsEntry,
  FsStat,
  GitStatus,
  MenuSettingsAction,
  ProjectFile,
  MenuSessionAction,
  OpenedSession,
  Project,
  PtyExitPayload,
  PtySpawnArgs,
  PtySpawnResult,
  ReviewerEntry,
  ReviewerGoal,
  ReviewerGoalEvent,
  ReviewerQuestion,
  ReviewerSpawnRequest,
  ReviewerStatus,
  SearchResult,
  SubGoal,
  ReviewerStreamEvent,
  ReviewerUsageEvent,
  RemoteStatus,
  TestPageState,
  ReviewerToolCallEvent,
  SessionFile,
  SessionSavePayload,
  SessionSummary,
  Settings,
  SettingsSection,
  SamplerKnobs,
  UsageSample,
} from './shared/ipc.js';

export type {
  AppInfo,
  BundleResult,
  FraktoleMessage,
  FsEntry,
  FsStat,
  GitStatus,
  MenuSettingsAction,
  MenuSessionAction,
  OpenedSession,
  Project,
  ProjectFile,
  PtyExitPayload,
  PtySpawnArgs,
  PtySpawnResult,
  ReviewerEntry,
  ReviewerGoal,
  ReviewerGoalEvent,
  ReviewerQuestion,
  ReviewerSpawnRequest,
  ReviewerStatus,
  SubGoal,
  ReviewerStreamEvent,
  ReviewerUsageEvent,
  RemoteStatus,
  TestPageState,
  ReviewerToolCallEvent,
  SessionFile,
  SessionSavePayload,
  SessionSummary,
  SearchResult,
  Settings,
  SettingsSection,
  SamplerKnobs,
  UsageSample,
};
export type SessionStatus = 'running' | 'idle' | 'stopped';

export interface FraktoleBridge {
  getAppInfo(): Promise<AppInfo>;
  ptySpawn(args: PtySpawnArgs): Promise<PtySpawnResult>;
  ptyWrite(sessionId: string, tileId: string, data: string): void;
  ptyResize(sessionId: string, tileId: string, cols: number, rows: number): void;
  ptyKill(sessionId: string, tileId: string): void;
  onPtyData(sessionId: string, tileId: string, cb: (data: string) => void): () => void;
  onTileExit(sessionId: string, tileId: string, cb: (payload: PtyExitPayload) => void): () => void;
  onMenuNewTile(cb: () => void): () => void;
  onMenuTheme(cb: (id: string) => void): () => void;
  applyTheme(id: string): Promise<void>;
  onMenuSession(cb: (action: MenuSessionAction) => void): () => void;
  onMenuHelp(cb: (topic: string) => void): () => void;
  /** Native Settings menu pick — open the Settings view, optionally at a section. */
  onMenuSettings(cb: (action: MenuSettingsAction) => void): () => void;
  /** Broadcast after every successful settings:set (full merged settings). */
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
  /** Reveal the userData directory in the system file manager. */
  revealDataDir(): Promise<void>;
  /** Watch an open editor file for out-of-app changes (agent edits). */
  watchFile(path: string): Promise<void>;
  unwatchFile(path: string): Promise<void>;
  /** Fired when a watched file changes on disk. */
  onFileChanged(cb: (path: string) => void): () => void;
  /** Explorer file operations; throw an Error message on failure. */
  mkdir(dirPath: string): Promise<void>;
  createFile(path: string): Promise<void>;
  renamePath(from: string, to: string): Promise<void>;
  /** Move to the OS trash (never a hard delete). */
  trashPath(path: string): Promise<void>;
  /** Git branch + change marks for a project root; null when not a repo. */
  gitStatus(projectPath: string): Promise<GitStatus | null>;
  /** Project-wide text search (ripgrep when available, bounded JS walk
   *  fallback). */
  searchProject(root: string, query: string): Promise<SearchResult>;
  /** Per-turn token usage samples for a session's reviewer (deltas). */
  usageHistory(sessionId: string): Promise<UsageSample[]>;
  listProjects(): Promise<Project[]>;
  addProject(path: string): Promise<Project>;
  removeProject(path: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  /** All files under a project root (bounded walk, for the quick-open
   *  palette). Returns [] on any error. */
  listProjectFiles(path: string): Promise<ProjectFile[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  listSessions(): Promise<SessionSummary[]>;
  newSession(name: string): Promise<OpenedSession>;
  saveSessionAs(id: string, name: string): Promise<SessionFile>;
  saveSession(sessionId: string, payload: SessionSavePayload): Promise<SessionFile | null>;
  openSession(id: string): Promise<OpenedSession>;
  deleteSession(id: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  startSession(id: string): Promise<void>;
  exportSessionBundle(id: string): Promise<BundleResult>;
  importSessionBundle(): Promise<BundleResult>;
  openProject(path: string): Promise<OpenedSession>;
  ensureReviewer(sessionId: string): Promise<boolean>;
  promptReviewer(sessionId: string, text: string): Promise<boolean>;
  stopReviewer(sessionId: string): Promise<void>;
  restartReviewer(sessionId: string): Promise<boolean>;
  compactReviewer(sessionId: string): Promise<void>;
  reviewerTranscript(sessionId: string): Promise<ReviewerEntry[]>;
  onReviewerStatus(sessionId: string, cb: (s: { status: string; error?: string; model?: string; variant?: string | null }) => void): () => void;
  onReviewerStream(sessionId: string, cb: (ev: ReviewerStreamEvent) => void): () => void;
  onReviewerToolCall(sessionId: string, cb: (ev: ReviewerToolCallEvent) => void): () => void;
  onReviewerMessage(sessionId: string, cb: (entry: ReviewerEntry) => void): () => void;
  setReviewerGoal(sessionId: string, text: string | null): Promise<void>;
  onReviewerGoal(sessionId: string, cb: (ev: ReviewerGoalEvent) => void): () => void;
  onReviewerUsage(sessionId: string, cb: (ev: ReviewerUsageEvent) => void): () => void;
  /** Start (variant) or clear (null) the autonomous-mode run for a session.
   *  mode 'auto' resumes a prior run in place when one exists; 'fresh'
   *  always re-forks. */
  setReviewerAutonomy(sessionId: string, variant: string | null, mode?: 'auto' | 'fresh'): Promise<{ ok: boolean; error?: string }>;
  /** True when re-entering `variant` can resume a prior run (active goal +
   *  existing non-empty fork). */
  resumableRun(sessionId: string, variant: string): Promise<{ resumable: boolean; goalText: string | null }>;
  /** Ask the model for a session recap and compact the context around it. */
  summarizeReviewer(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  onReviewerRecap(sessionId: string, cb: (recap: { text: string; at: number }) => void): () => void;
  /** The resolved context budget (server-probed ≤ knob ≤ guess) at start. */
  onReviewerBudget(sessionId: string, cb: (info: { contextTokens: number; probed?: number }) => void): () => void;
  listReviewerModels(opts: { adapter: string; apiKey: string; baseUrl: string }): Promise<string[]>;
  onReviewerQuestion(sessionId: string, cb: (ev: ReviewerQuestion) => void): () => void;
  answerReviewerQuestion(sessionId: string, askId: string, answer: string): Promise<void>;
  killReviewerAgent(sessionId: string, agentId: string): Promise<string>;
  onReviewerSpawnRequest(cb: (ev: ReviewerSpawnRequest) => void): () => void;
  reviewerSpawnResult(
    sessionId: string,
    requestId: string,
    payload: { tileId: string | null; agentId: string | null },
  ): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
  clipboardRead(): Promise<string>;
  onTestOpen(cb: (sessionId: string, ev: { url: string }) => void): () => void;
  onTestStateRequest(sessionId: string, cb: (ev: { requestId: string }) => void): () => void;
  testStateResponse(sessionId: string, requestId: string, state: TestPageState): Promise<void>;
  onTestScreenshotRequest(sessionId: string, cb: (ev: { requestId: string }) => void): () => void;
  testScreenshotResponse(sessionId: string, requestId: string, dataUrl: string | null): Promise<void>;
  onTestReload(sessionId: string, cb: () => void): () => void;
  getScrollback(sessionId: string, agentId: string): Promise<string[] | null>;
  listDir(path: string): Promise<FsEntry[]>;
  readFile(path: string): Promise<{ content: string; size: number }>;
  writeFile(path: string, content: string): Promise<void>;
  statFile(path: string): Promise<FsStat>;
  getRemoteStatus(): Promise<RemoteStatus>;
  setRemoteEnabled(enabled: boolean): Promise<RemoteStatus>;
  setRemotePort(port: number): Promise<RemoteStatus>;
  revokeRemoteDevice(deviceId: string): Promise<boolean>;
  onRemoteStatus(cb: (status: RemoteStatus) => void): () => void;
}

export const bridge: FraktoleBridge = window.fraktole;

declare global {
  interface Window {
    fraktole: FraktoleBridge;
  }
}
