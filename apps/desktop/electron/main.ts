import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { copyFile, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { SettingsStore } from './settings.js';
import { IPC, type AppInfo, type PtySpawnArgs, type Settings } from '../src/shared/ipc.js';
import { THEME_IDS, type ThemeId } from '../src/themes.js';

// Consistent identity across dev, local install and packaged builds: WM_CLASS,
// window association and the userData directory all key off the app name.
app.setName('Fraktole');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';

async function waitForDevServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet — keep polling
    }
    if (Date.now() > deadline) throw new Error(`dev server unreachable at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let mainWindow: BrowserWindow | null = null;
let ptyHost: PtyHost | null = null;
let currentTheme: ThemeId = 'midnight';

/** Custom application menu: File → New Tile/Quit, View → Theme. The default
 *  Electron menu would expose Reload (orphaning every PTY) and DevTools in
 *  production. */
function buildMenu(currentTheme: ThemeId): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tile',
          accelerator: 'Ctrl+Shift+T',
          click: () => mainWindow?.webContents.send(IPC.menuNewTile),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme',
          submenu: THEME_IDS.map((id) => ({
            label: id.charAt(0).toUpperCase() + id.slice(1),
            type: 'checkbox' as const,
            checked: id === currentTheme,
            click: () => mainWindow?.webContents.send(IPC.menuTheme, id),
          })),
        },
      ],
    },
  ]);
}

/**
 * Older builds stored data under the package-name userData dir
 * (~/.config/@fraktole/desktop). Migrate the project list once.
 */
function migrateUserData(): void {
  const current = app.getPath('userData');
  const legacy = join(app.getPath('appData'), '@fraktole', 'desktop');
  if (legacy === current) return;
  if (existsSync(join(current, 'projects.json'))) return;
  const legacyProjects = join(legacy, 'projects.json');
  if (existsSync(legacyProjects)) {
    try {
      copyFile(legacyProjects, join(current, 'projects.json'), (err) => {
        if (err) console.error('migrate projects.json failed:', err);
      });
    } catch {
      // migration is best-effort
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#171a20',
    show: false,
    title: 'Fraktole',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // a main-frame navigation (e.g. reload) would orphan every running PTY:
  // the renderer would reset to zero tiles while PtyHost keeps every session.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => {
    ptyHost?.killAll();
    app.quit();
  });

  void (async () => {
    if (!app.isPackaged) {
      await waitForDevServer(DEV_SERVER_URL);
      await win.loadURL(DEV_SERVER_URL);
    } else {
      await win.loadFile(join(__dirname, '..', 'dist-renderer', 'index.html'));
    }
  })();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    migrateUserData();
    const host = new PtyHost({
      send: (channel, tileId, payload) => {
        mainWindow?.webContents.send(channel, tileId, payload);
      },
    });
    ptyHost = host;

    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      shell: process.env.SHELL ?? '/bin/bash',
      userData: app.getPath('userData'),
      home: app.getPath('home'),
    }));
    ipcMain.handle(IPC.ptySpawn, (_e, args: PtySpawnArgs) => {
      try {
        host.spawn(args.tileId, args.cwd, args.cols, args.rows);
      } catch (err) {
        // a failed spawn must close the tile through the normal exit path,
        // otherwise the renderer would keep a dead tile forever
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        mainWindow?.webContents.send(IPC.tileExit, args.tileId, { code: -1 });
      }
    });
    ipcMain.on(IPC.ptyWrite, (_e, tileId: string, data: string) => host.write(tileId, data));
    ipcMain.on(IPC.ptyResize, (_e, tileId: string, cols: number, rows: number) =>
      host.resize(tileId, cols, rows),
    );
    ipcMain.on(IPC.ptyKill, (_e, tileId: string) => host.kill(tileId));

    const projects = new ProjectsStore(join(app.getPath('userData'), 'projects.json'));
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
    currentTheme = ((await settings.get()).theme as ThemeId) ?? 'midnight';
    if (!THEME_IDS.includes(currentTheme)) currentTheme = 'midnight';
    Menu.setApplicationMenu(buildMenu(currentTheme));
    ipcMain.handle(IPC.projectsList, () => projects.list());
    ipcMain.handle(IPC.projectsAdd, (_e, path: string) => projects.add(path));
    ipcMain.handle(IPC.projectsRemove, (_e, path: string) => projects.remove(path));
    ipcMain.handle(IPC.settingsGet, () => settings.get());
    ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<Settings>) => {
      const next = await settings.set(patch);
      if (THEME_IDS.includes(next.theme as ThemeId)) {
        currentTheme = next.theme as ThemeId;
        Menu.setApplicationMenu(buildMenu(currentTheme));
      }
      return next;
    });
    ipcMain.handle(IPC.pickFolder, async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Add a project folder',
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    app.on('will-quit', () => ptyHost?.killAll());

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
