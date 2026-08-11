import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type FraktoleMessage,
  type MenuSessionAction,
  type OpenedSession,
  type Project,
  type PtyExitPayload,
  type PtySpawnArgs,
  type PtySpawnResult,
  type SendMessageArgs,
  type SessionFile,
  type SessionSavePayload,
  type SessionSummary,
  type SessionSnapshot,
  type Settings,
} from '../src/shared/ipc.js';

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  ptySpawn: (args: PtySpawnArgs): Promise<PtySpawnResult> => ipcRenderer.invoke(IPC.ptySpawn, args),
  ptyWrite: (tileId: string, data: string): void => ipcRenderer.send(IPC.ptyWrite, tileId, data),
  ptyResize: (tileId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.ptyResize, tileId, cols, rows),
  ptyKill: (tileId: string): void => ipcRenderer.send(IPC.ptyKill, tileId),

  onPtyData: (tileId: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, data: string): void => {
      if (id === tileId) cb(data);
    };
    ipcRenderer.on(IPC.ptyData, listener);
    return () => ipcRenderer.removeListener(IPC.ptyData, listener);
  },
  onTileExit: (tileId: string, cb: (payload: PtyExitPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, payload: PtyExitPayload): void => {
      if (id === tileId) cb(payload);
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
  onMenuSession: (cb: (action: MenuSessionAction) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: MenuSessionAction): void => cb(action);
    ipcRenderer.on(IPC.menuSession, listener);
    return () => ipcRenderer.removeListener(IPC.menuSession, listener);
  },

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.sessionsList),
  newSession: (name: string): Promise<OpenedSession> => ipcRenderer.invoke(IPC.sessionNew, name),
  saveSessionAs: (id: string, name: string): Promise<SessionFile> =>
    ipcRenderer.invoke(IPC.sessionSaveAs, id, name),
  saveSession: (payload: SessionSavePayload): Promise<SessionFile | null> =>
    ipcRenderer.invoke(IPC.sessionSave, payload),
  openSession: (id: string): Promise<OpenedSession> => ipcRenderer.invoke(IPC.sessionOpen, id),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionDelete, id),

  sendMessage: (args: SendMessageArgs): Promise<boolean> => ipcRenderer.invoke(IPC.messageSend, args),
  listMessages: (): Promise<FraktoleMessage[]> => ipcRenderer.invoke(IPC.messageList),
  onMessageEvent: (cb: (msg: FraktoleMessage) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: FraktoleMessage): void => cb(msg);
    ipcRenderer.on(IPC.messageEvent, listener);
    return () => ipcRenderer.removeListener(IPC.messageEvent, listener);
  },
  onJudgeExit: (cb: (payload: PtyExitPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: PtyExitPayload): void => cb(payload);
    ipcRenderer.on(IPC.judgeExit, listener);
    return () => ipcRenderer.removeListener(IPC.judgeExit, listener);
  },
  judgeRestart: (): Promise<boolean> => ipcRenderer.invoke(IPC.judgeRestart),

  createSnapshot: (args: { agentId: string; text: string }): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IPC.snapshotCreate, args),
  getSnapshot: (id: string): Promise<SessionSnapshot | null> =>
    ipcRenderer.invoke(IPC.snapshotGet, id),
  getScrollback: (agentId: string): Promise<string[] | null> =>
    ipcRenderer.invoke(IPC.scrollbackGet, agentId),

  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projectsList),
  addProject: (path: string): Promise<Project> => ipcRenderer.invoke(IPC.projectsAdd, path),
  removeProject: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.projectsRemove, path),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch),
};

contextBridge.exposeInMainWorld('fraktole', api);

export type FraktoleBridge = typeof api;
