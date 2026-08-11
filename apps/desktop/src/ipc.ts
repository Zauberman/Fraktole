import type { AppInfo, Project, PtyExitPayload, PtySpawnArgs, Settings } from './shared/ipc.js';

export type { AppInfo, Project, PtyExitPayload, PtySpawnArgs, Settings };

export interface FraktoleBridge {
  getAppInfo(): Promise<AppInfo>;
  ptySpawn(args: PtySpawnArgs): Promise<void>;
  ptyWrite(tileId: string, data: string): void;
  ptyResize(tileId: string, cols: number, rows: number): void;
  ptyKill(tileId: string): void;
  onPtyData(tileId: string, cb: (data: string) => void): () => void;
  onTileExit(tileId: string, cb: (payload: PtyExitPayload) => void): () => void;
  onMenuNewTile(cb: () => void): () => void;
  onMenuTheme(cb: (id: string) => void): () => void;
  listProjects(): Promise<Project[]>;
  addProject(path: string): Promise<Project>;
  removeProject(path: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
}

export const bridge: FraktoleBridge = window.fraktole;

declare global {
  interface Window {
    fraktole: FraktoleBridge;
  }
}
