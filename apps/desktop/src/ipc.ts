import type {
  AppInfo,
  FraktoleMessage,
  FsEntry,
  FsStat,
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
  SubGoal,
  ReviewerStreamEvent,
  ReviewerUsageEvent,
  RemoteStatus,
  TestPageState,
  ReviewerToolCallEvent,
  SendMessageArgs,
  SessionFile,
  SessionSavePayload,
  SessionSummary,
  SessionSnapshot,
  Settings,
} from './shared/ipc.js';

export type {
  AppInfo,
  FraktoleMessage,
  FsEntry,
  FsStat,
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
  SubGoal,
  ReviewerStreamEvent,
  ReviewerUsageEvent,
  RemoteStatus,
  TestPageState,
  ReviewerToolCallEvent,
  SendMessageArgs,
  SessionFile,
  SessionSavePayload,
  SessionSummary,
  SessionSnapshot,
  Settings,
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
  listProjects(): Promise<Project[]>;
  addProject(path: string): Promise<Project>;
  removeProject(path: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
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
  openProject(path: string): Promise<OpenedSession>;
  sendMessage(sessionId: string, args: SendMessageArgs): Promise<boolean>;
  listMessages(sessionId: string): Promise<FraktoleMessage[]>;
  onMessageEvent(sessionId: string, cb: (msg: FraktoleMessage) => void): () => void;
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
  /** Start (variant) or clear (null) the autonomous-mode run for a session. */
  setReviewerAutonomy(sessionId: string, variant: string | null): Promise<{ ok: boolean; error?: string }>;
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
  createSnapshot(sessionId: string, args: { agentId: string; text: string }): Promise<SessionSnapshot>;
  getSnapshot(sessionId: string, id: string): Promise<SessionSnapshot | null>;
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
