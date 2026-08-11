import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AppInfo, type Project, type PtyExitPayload, type PtySpawnArgs, type Settings } from '../src/shared/ipc.js';

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  ptySpawn: (args: PtySpawnArgs): Promise<void> => ipcRenderer.invoke(IPC.ptySpawn, args),
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

  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projectsList),
  addProject: (path: string): Promise<Project> => ipcRenderer.invoke(IPC.projectsAdd, path),
  removeProject: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.projectsRemove, path),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch),
};

contextBridge.exposeInMainWorld('fraktole', api);

export type FraktoleBridge = typeof api;
