import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type FraktoleMessage,
  type FsEntry,
  type FsStat,
  type MenuSessionAction,
  type OpenedSession,
  type Project,
  type PtyExitPayload,
  type PtySpawnArgs,
  type PtySpawnResult,
  type ReviewerEntry,
  type ReviewerGoalEvent,
  type ReviewerUsageEvent,
  type ReviewerQuestion,
  type ReviewerSpawnRequest,
  type ReviewerStreamEvent,
  type ReviewerToolCallEvent,
  type RemoteStatus,
  type SendMessageArgs,
  type SessionFile,
  type SessionSavePayload,
  type SessionSummary,
  type SessionSnapshot,
  type Settings,
  type TestPageState,
} from '../src/shared/ipc.js';

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  ptySpawn: (args: PtySpawnArgs): Promise<PtySpawnResult> => ipcRenderer.invoke(IPC.ptySpawn, args),
  ptyWrite: (sessionId: string, tileId: string, data: string): void =>
    ipcRenderer.send(IPC.ptyWrite, sessionId, tileId, data),
  ptyResize: (sessionId: string, tileId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.ptyResize, sessionId, tileId, cols, rows),
  ptyKill: (sessionId: string, tileId: string): void =>
    ipcRenderer.send(IPC.ptyKill, sessionId, tileId),

  onPtyData: (sessionId: string, tileId: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, id: string, data: string): void => {
      if (sid === sessionId && id === tileId) cb(data);
    };
    ipcRenderer.on(IPC.ptyData, listener);
    return () => ipcRenderer.removeListener(IPC.ptyData, listener);
  },
  onTileExit: (sessionId: string, tileId: string, cb: (payload: PtyExitPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, id: string, payload: PtyExitPayload): void => {
      if (sid === sessionId && id === tileId) cb(payload);
    };
    ipcRenderer.on(IPC.tileExit, listener);
    return () => ipcRenderer.removeListener(IPC.tileExit, listener);
  },

  onMenuNewTile: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC.menuNewTile, listener);
    return () => ipcRenderer.removeListener(IPC.menuNewTile, listener);
  },
  onMenuTheme: (cb: (id: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string): void => cb(id);
    ipcRenderer.on(IPC.menuTheme, listener);
    return () => ipcRenderer.removeListener(IPC.menuTheme, listener);
  },
  applyTheme: (id: string): Promise<void> => ipcRenderer.invoke(IPC.themeApply, id),
  onMenuSession: (cb: (action: MenuSessionAction) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: MenuSessionAction): void => cb(action);
    ipcRenderer.on(IPC.menuSession, listener);
    return () => ipcRenderer.removeListener(IPC.menuSession, listener);
  },

  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projectsList),
  addProject: (path: string): Promise<Project> => ipcRenderer.invoke(IPC.projectsAdd, path),
  removeProject: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.projectsRemove, path),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.sessionsList),
  newSession: (name: string): Promise<OpenedSession> => ipcRenderer.invoke(IPC.sessionNew, name),
  saveSessionAs: (id: string, name: string): Promise<SessionFile> =>
    ipcRenderer.invoke(IPC.sessionSaveAs, id, name),
  saveSession: (sessionId: string, payload: SessionSavePayload): Promise<SessionFile | null> =>
    ipcRenderer.invoke(IPC.sessionSave, sessionId, payload),
  openSession: (id: string): Promise<OpenedSession> => ipcRenderer.invoke(IPC.sessionOpen, id),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionDelete, id),
  stopSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionStop, id),
  startSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionStart, id),
  openProject: (path: string): Promise<OpenedSession> => ipcRenderer.invoke(IPC.projectOpen, path),

  sendMessage: (sessionId: string, args: SendMessageArgs): Promise<boolean> =>
    ipcRenderer.invoke(IPC.messageSend, sessionId, args),
  listMessages: (sessionId: string): Promise<FraktoleMessage[]> =>
    ipcRenderer.invoke(IPC.messageList, sessionId),
  onMessageEvent: (sessionId: string, cb: (msg: FraktoleMessage) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, msg: FraktoleMessage): void => {
      if (sid === sessionId) cb(msg);
    };
    ipcRenderer.on(IPC.messageEvent, listener);
    return () => ipcRenderer.removeListener(IPC.messageEvent, listener);
  },
  ensureReviewer: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.reviewerEnsure, sessionId),
  promptReviewer: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.reviewerPrompt, sessionId, text),
  stopReviewer: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.reviewerStop, sessionId),
  restartReviewer: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.reviewerRestart, sessionId),
  compactReviewer: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.reviewerCompact, sessionId),
  reviewerTranscript: (sessionId: string): Promise<ReviewerEntry[]> =>
    ipcRenderer.invoke(IPC.reviewerTranscript, sessionId),

  onReviewerStatus: (sessionId: string, cb: (s: { status: string; error?: string; model?: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, s: { status: string; error?: string; model?: string }): void => {
      if (sid === sessionId) cb(s);
    };
    ipcRenderer.on(IPC.reviewerStatus, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerStatus, listener);
  },
  onReviewerStream: (sessionId: string, cb: (ev: ReviewerStreamEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: ReviewerStreamEvent): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.reviewerStream, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerStream, listener);
  },
  onReviewerToolCall: (sessionId: string, cb: (ev: ReviewerToolCallEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: ReviewerToolCallEvent): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.reviewerToolCall, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerToolCall, listener);
  },
  onReviewerMessage: (sessionId: string, cb: (entry: ReviewerEntry) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, entry: ReviewerEntry): void => {
      if (sid === sessionId) cb(entry);
    };
    ipcRenderer.on(IPC.reviewerMessage, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerMessage, listener);
  },

  setReviewerGoal: (sessionId: string, text: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.reviewerSetGoal, sessionId, text),
  onReviewerGoal: (sessionId: string, cb: (ev: ReviewerGoalEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: ReviewerGoalEvent): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.reviewerGoal, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerGoal, listener);
  },
  onReviewerUsage: (sessionId: string, cb: (ev: ReviewerUsageEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: ReviewerUsageEvent): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.reviewerUsage, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerUsage, listener);
  },
  setReviewerAutonomy: (sessionId: string, variant: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.reviewerAutonomy, sessionId, variant),
  listReviewerModels: (opts: { adapter: string; apiKey: string; baseUrl: string }): Promise<string[]> =>
    ipcRenderer.invoke(IPC.reviewerListModels, opts),
  onReviewerQuestion: (sessionId: string, cb: (ev: ReviewerQuestion) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: ReviewerQuestion): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.reviewerQuestion, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerQuestion, listener);
  },
  answerReviewerQuestion: (sessionId: string, askId: string, answer: string): Promise<void> =>
    ipcRenderer.invoke(IPC.reviewerAnswer, sessionId, askId, answer),
  killReviewerAgent: (sessionId: string, agentId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.reviewerKillNow, sessionId, agentId),
  onReviewerSpawnRequest: (cb: (ev: ReviewerSpawnRequest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: ReviewerSpawnRequest): void => cb(payload);
    ipcRenderer.on(IPC.reviewerSpawnRequest, listener);
    return () => ipcRenderer.removeListener(IPC.reviewerSpawnRequest, listener);
  },
  reviewerSpawnResult: (
    sessionId: string,
    requestId: string,
    payload: { tileId: string | null; agentId: string | null },
  ): Promise<void> => ipcRenderer.invoke(IPC.reviewerSpawnResult, sessionId, requestId, payload),

  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
  clipboardRead: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),

  onTestOpen: (cb: (sessionId: string, ev: { url: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: { url: string }): void => cb(sid, ev);
    ipcRenderer.on(IPC.testOpen, listener);
    return () => ipcRenderer.removeListener(IPC.testOpen, listener);
  },
  onTestStateRequest: (sessionId: string, cb: (ev: { requestId: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: { requestId: string }): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.testStateRequest, listener);
    return () => ipcRenderer.removeListener(IPC.testStateRequest, listener);
  },
  testStateResponse: (sessionId: string, requestId: string, state: TestPageState): Promise<void> =>
    ipcRenderer.invoke(IPC.testState, sessionId, requestId, state),
  onTestScreenshotRequest: (sessionId: string, cb: (ev: { requestId: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string, ev: { requestId: string }): void => {
      if (sid === sessionId) cb(ev);
    };
    ipcRenderer.on(IPC.testScreenshotRequest, listener);
    return () => ipcRenderer.removeListener(IPC.testScreenshotRequest, listener);
  },
  testScreenshotResponse: (sessionId: string, requestId: string, dataUrl: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.testScreenshot, sessionId, requestId, dataUrl),
  onTestReload: (sessionId: string, cb: () => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, sid: string): void => {
      if (sid === sessionId) cb();
    };
    ipcRenderer.on(IPC.testReload, listener);
    return () => ipcRenderer.removeListener(IPC.testReload, listener);
  },

  createSnapshot: (sessionId: string, args: { agentId: string; text: string }): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IPC.snapshotCreate, sessionId, args),
  getSnapshot: (sessionId: string, id: string): Promise<SessionSnapshot | null> =>
    ipcRenderer.invoke(IPC.snapshotGet, sessionId, id),
  getScrollback: (sessionId: string, agentId: string): Promise<string[] | null> =>
    ipcRenderer.invoke(IPC.scrollbackGet, sessionId, agentId),

  listDir: (path: string): Promise<FsEntry[]> => ipcRenderer.invoke(IPC.fsListDir, path),
  readFile: (path: string): Promise<{ content: string; size: number }> =>
    ipcRenderer.invoke(IPC.fsReadFile, path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.fsWriteFile, path, content),
  statFile: (path: string): Promise<FsStat> => ipcRenderer.invoke(IPC.fsStat, path),

  getRemoteStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke(IPC.remoteGetState),
  setRemoteEnabled: (enabled: boolean): Promise<RemoteStatus> =>
    ipcRenderer.invoke(IPC.remoteSetEnabled, enabled),
  setRemotePort: (port: number): Promise<RemoteStatus> => ipcRenderer.invoke(IPC.remoteSetPort, port),
  revokeRemoteDevice: (deviceId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.remoteRevokeDevice, deviceId),
  onRemoteStatus: (cb: (status: RemoteStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: RemoteStatus): void => cb(status);
    ipcRenderer.on(IPC.remoteStatus, listener);
    return () => ipcRenderer.removeListener(IPC.remoteStatus, listener);
  },
};

contextBridge.exposeInMainWorld('fraktole', api);

export type FraktoleBridge = typeof api;
