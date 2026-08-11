import type {
  AppInfo,
  FraktoleMessage,
  MenuSessionAction,
  OpenedSession,
  Project,
  PtyExitPayload,
  PtySpawnArgs,
  PtySpawnResult,
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
  MenuSessionAction,
  OpenedSession,
  Project,
  PtyExitPayload,
  PtySpawnArgs,
  PtySpawnResult,
  SendMessageArgs,
  SessionFile,
  SessionSavePayload,
  SessionSummary,
  SessionSnapshot,
  Settings,
};

export interface FraktoleBridge {
  getAppInfo(): Promise<AppInfo>;
  ptySpawn(args: PtySpawnArgs): Promise<PtySpawnResult>;
  ptyWrite(tileId: string, data: string): void;
  ptyResize(tileId: string, cols: number, rows: number): void;
  ptyKill(tileId: string): void;
  onPtyData(tileId: string, cb: (data: string) => void): () => void;
  onTileExit(tileId: string, cb: (payload: PtyExitPayload) => void): () => void;
  onMenuNewTile(cb: () => void): () => void;
  onMenuTheme(cb: (id: string) => void): () => void;
  onMenuSession(cb: (action: MenuSessionAction) => void): () => void;
  listProjects(): Promise<Project[]>;
  addProject(path: string): Promise<Project>;
  removeProject(path: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  listSessions(): Promise<SessionSummary[]>;
  newSession(name: string): Promise<OpenedSession>;
  saveSessionAs(id: string, name: string): Promise<SessionFile>;
  saveSession(payload: SessionSavePayload): Promise<SessionFile | null>;
  openSession(id: string): Promise<OpenedSession>;
  deleteSession(id: string): Promise<void>;
  sendMessage(args: SendMessageArgs): Promise<boolean>;
  listMessages(): Promise<FraktoleMessage[]>;
  onMessageEvent(cb: (msg: FraktoleMessage) => void): () => void;
  onJudgeExit(cb: (payload: PtyExitPayload) => void): () => void;
  judgeRestart(): Promise<boolean>;
  createSnapshot(args: { agentId: string; text: string }): Promise<SessionSnapshot>;
  getSnapshot(id: string): Promise<SessionSnapshot | null>;
  getScrollback(agentId: string): Promise<string[] | null>;
}

export const bridge: FraktoleBridge = window.fraktole;

declare global {
  interface Window {
    fraktole: FraktoleBridge;
  }
}
