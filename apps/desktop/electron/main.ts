import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { copyFile, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { SettingsStore } from './settings.js';
import { IPC, type AppInfo, type PtySpawnArgs, type Settings } from '../src/shared/ipc.js';

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
  app.whenReady().then(() => {
    migrateUserData();
    const ptyHost = new PtyHost({
      send: (channel, tileId, payload) => {
        mainWindow?.webContents.send(channel, tileId, payload);
      },
    });

    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      shell: process.env.SHELL ?? '/bin/bash',
      userData: app.getPath('userData'),
      home: app.getPath('home'),
    }));
    ipcMain.handle(IPC.ptySpawn, (_e, args: PtySpawnArgs) => {
      ptyHost.spawn(args.tileId, args.cwd, args.cols, args.rows);
    });
    ipcMain.on(IPC.ptyWrite, (_e, tileId: string, data: string) => ptyHost.write(tileId, data));
    ipcMain.on(IPC.ptyResize, (_e, tileId: string, cols: number, rows: number) =>
      ptyHost.resize(tileId, cols, rows),
    );
    ipcMain.on(IPC.ptyKill, (_e, tileId: string) => ptyHost.kill(tileId));

    const projects = new ProjectsStore(join(app.getPath('userData'), 'projects.json'));
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
    ipcMain.handle(IPC.projectsList, () => projects.list());
    ipcMain.handle(IPC.projectsAdd, (_e, path: string) => projects.add(path));
    ipcMain.handle(IPC.projectsRemove, (_e, path: string) => projects.remove(path));
    ipcMain.handle(IPC.settingsGet, () => settings.get());
    ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => settings.set(patch));
    ipcMain.handle(IPC.pickFolder, async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Add a project folder',
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    app.on('will-quit', () => ptyHost.killAll());

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
