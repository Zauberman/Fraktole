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
} as const;

export interface AppInfo {
  version: string;
  shell: string;
  userData: string;
  home: string;
}

export interface PtySpawnArgs {
  tileId: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyExitPayload {
  code: number | null;
}

export interface Project {
  path: string;
  name: string;
  lastUsed: number;
}

export interface Settings {
  theme: string;
}
