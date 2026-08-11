import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { copyFile, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JudgeHost, buildAgentEnv } from './judge.js';
import { MailboxRouter, ORCHESTRATOR_ID, messageId } from './mailbox.js';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { SessionStore } from './sessions.js';
import { DEFAULT_JUDGE_COMMAND, SettingsStore } from './settings.js';
import {
  IPC,
  type AppInfo,
  type OpenedSession,
  type PtySpawnArgs,
  type PtySpawnResult,
  type SendMessageArgs,
  type SessionFile,
  type SessionSavePayload,
  type SessionSnapshot,
  type Settings,
} from '../src/shared/ipc.js';
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

/** Custom application menu: File → New Tile/Sessions/Quit, View → Theme.
 *  The default Electron menu would expose Reload (orphaning every PTY) and
 *  DevTools in production. Session actions are forwarded to the renderer,
 *  which owns the save/switch flows (it holds the live workspace state). */
function buildMenu(currentTheme: ThemeId, sessions: Array<{ id: string; name: string }>): Menu {
  const sessionMenu: Electron.MenuItemConstructorOptions[] = [
    { label: 'New Session…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'new' }) },
    { label: 'Save As…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'save-as' }) },
  ];
  if (sessions.length > 0) {
    sessionMenu.push({ type: 'separator' });
    for (const s of sessions) {
      sessionMenu.push({
        label: s.name,
        click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'open', id: s.id }),
      });
    }
    sessionMenu.push({ type: 'separator' });
    sessionMenu.push({
      label: 'Delete Session…',
      submenu: sessions.map((s) => ({
        label: s.name,
        click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'delete', id: s.id }),
      })),
    });
  }
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
        { label: 'Sessions', submenu: sessionMenu },
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

    const projects = new ProjectsStore(join(app.getPath('userData'), 'projects.json'));
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
    const sessions = new SessionStore(join(app.getPath('userData'), 'sessions'));
    let judgeCommand = ((await settings.get()).judgeCommand) ?? DEFAULT_JUDGE_COMMAND;

    // durable agent ids ↔ live tile ids, so the router can echo messages
    // into the right terminal
    const agentToTile = new Map<string, string>();
    let currentSession: SessionFile | null = null;

    let judgeHost: JudgeHost | null = null;
    const host = new PtyHost({
      send: (channel, tileId, payload) => {
        if (channel === IPC.tileExit && tileId === ORCHESTRATOR_ID) {
          judgeHost?.markExited();
          mainWindow?.webContents.send(IPC.judgeExit, payload);
        }
        mainWindow?.webContents.send(channel, tileId, payload);
      },
    });
    ptyHost = host;
    judgeHost = new JudgeHost({ host, getCommand: () => judgeCommand });
    const router = new MailboxRouter({
      root: join(app.getPath('userData'), 'sessions'),
      currentSession: () => currentSession,
      tileOfAgent: (agentId) => (agentId === ORCHESTRATOR_ID ? ORCHESTRATOR_ID : (agentToTile.get(agentId) ?? null)),
      write: (tileId, text) => host.write(tileId, text),
      emit: (msg) => mainWindow?.webContents.send(IPC.messageEvent, msg),
    });

    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      shell: process.env.SHELL ?? '/bin/bash',
      userData: app.getPath('userData'),
      home: app.getPath('home'),
    }));
    ipcMain.handle(IPC.ptySpawn, async (_e, args: PtySpawnArgs): Promise<PtySpawnResult> => {
      const session = currentSession;
      if (!session) throw new Error('no active session');
      // restore passes the persisted agentId; live spawns get a fresh one
      let agentId = args.agentId ?? null;
      if (agentId === null || !session.tiles.some((t) => t.agentId === agentId)) {
        agentId = sessions.allocateAgentId(session);
        session.tiles.push({ agentId, cwd: args.cwd });
        await sessions.save(session);
      }
      await sessions.ensureAgentMailbox(session.id, agentId);
      agentToTile.set(agentId, args.tileId);
      const sessionDir = join(app.getPath('userData'), 'sessions', session.id);
      const env = buildAgentEnv(session.id, agentId, 'agent', sessionDir);
      try {
        host.spawn(args.tileId, { cwd: args.cwd, cols: args.cols, rows: args.rows, envExt: env });
      } catch (err) {
        // a failed spawn must close the tile through the normal exit path,
        // otherwise the renderer would keep a dead tile forever
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        mainWindow?.webContents.send(IPC.tileExit, args.tileId, { code: -1 });
      }
      return { agentId };
    });
    ipcMain.on(IPC.ptyWrite, (_e, tileId: string, data: string) => host.write(tileId, data));
    ipcMain.on(IPC.ptyResize, (_e, tileId: string, cols: number, rows: number) =>
      host.resize(tileId, cols, rows),
    );
    ipcMain.on(IPC.ptyKill, (_e, tileId: string) => host.kill(tileId));

    currentTheme = ((await settings.get()).theme as ThemeId) ?? 'midnight';
    if (!THEME_IDS.includes(currentTheme)) currentTheme = 'midnight';
    const refreshMenu = (): void => {
      void sessions.list().then((list) => {
        Menu.setApplicationMenu(buildMenu(currentTheme, list));
      });
    };
    refreshMenu();
    ipcMain.handle(IPC.projectsList, () => projects.list());
    ipcMain.handle(IPC.projectsAdd, (_e, path: string) => projects.add(path));
    ipcMain.handle(IPC.projectsRemove, (_e, path: string) => projects.remove(path));
    ipcMain.handle(IPC.settingsGet, () => settings.get());
    ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<Settings>) => {
      const next = await settings.set(patch);
      if (typeof next.judgeCommand === 'string' && next.judgeCommand.length > 0) {
        judgeCommand = next.judgeCommand;
      }
      if (THEME_IDS.includes(next.theme as ThemeId)) {
        currentTheme = next.theme as ThemeId;
        refreshMenu();
      }
      return next;
    });
    ipcMain.handle(IPC.sessionsList, () => sessions.list());
    ipcMain.handle(IPC.sessionNew, async (_e, name: string): Promise<OpenedSession> => {
      router.stop();
      const opened = await sessions.newSession(name);
      currentSession = opened.session;
      const started = judgeHost.spawn(
        opened.session.id,
        join(app.getPath('userData'), 'sessions', opened.session.id),
        app.getPath('home'),
      );
      if (!started) mainWindow?.webContents.send(IPC.judgeExit, { code: -1 });
      router.start(opened.session.id);
      refreshMenu();
      return opened;
    });
    ipcMain.handle(IPC.sessionSaveAs, async (_e, id: string, name: string) => {
      const session = await sessions.rename(id, name);
      if (currentSession?.id === id) currentSession = session;
      refreshMenu();
      return session;
    });
    ipcMain.handle(IPC.sessionOpen, async (_e, id: string): Promise<OpenedSession> => {
      // opening a session tears down the current one: every live PTY dies,
      // the renderer then rebuilds the tree and re-spawns its agents
      router.stop();
      ptyHost?.killAll();
      const session = await sessions.load(id);
      currentSession = session;
      const sessionDir = join(app.getPath('userData'), 'sessions', session.id);
      const judgeCwd = session.judge?.cwd ?? app.getPath('home');
      const started = judgeHost.spawn(session.id, sessionDir, judgeCwd);
      if (!started) mainWindow?.webContents.send(IPC.judgeExit, { code: -1 });
      router.start(session.id);
      refreshMenu();
      return { session, agents: session.tiles };
    });
    ipcMain.handle(IPC.sessionDelete, async (_e, id: string) => {
      await sessions.delete(id);
      refreshMenu();
    });
    ipcMain.handle(IPC.sessionSave, async (_e, payload: SessionSavePayload) => {
      const session = currentSession;
      if (!session) return null;
      session.tree = payload.tree;
      // null clears the persisted value (user unzoomed/unfocused), undefined
      // means "not part of this payload"
      if (payload.zoomedAgentId !== undefined) session.zoomedAgentId = payload.zoomedAgentId ?? undefined;
      if (payload.focusedAgentId !== undefined) session.focusedAgentId = payload.focusedAgentId ?? undefined;
      if (payload.judgeCwd) session.judge = { command: judgeCommand, cwd: payload.judgeCwd };
      // prunes agents closed since the last save; mailboxes stay on disk
      session.tiles = session.tiles.filter((t) => payload.agents.includes(t.agentId));
      await sessions.save(session);
      if (payload.scrollback) {
        const sessionDir = join(app.getPath('userData'), 'sessions', session.id);
        await mkdir(join(sessionDir, 'scrollback'), { recursive: true });
        for (const [agentId, lines] of Object.entries(payload.scrollback)) {
          await writeFile(
            join(sessionDir, 'scrollback', `${agentId}.json`),
            JSON.stringify({ lines }, null, 2),
            'utf8',
          );
        }
      }
      return session;
    });
    ipcMain.handle(IPC.messageSend, async (_e, args: SendMessageArgs): Promise<boolean> => {
      if (!currentSession) return false;
      return router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to: args.to,
        kind: args.kind,
        body: args.body,
        ref: args.ref,
        at: Date.now(),
      });
    });
    ipcMain.handle(IPC.messageList, async () => {
      if (!currentSession) return [];
      return router.listMessages(currentSession.id);
    });
    ipcMain.handle(IPC.snapshotCreate, async (_e, args: { agentId: string; text: string }): Promise<SessionSnapshot> => {
      const session = currentSession;
      if (!session) throw new Error('no active session');
      const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const snapshot: SessionSnapshot = {
        id,
        agentId: args.agentId,
        at: Date.now(),
        lineCount: args.text.length > 0 ? args.text.split('\n').length : 0,
        text: args.text,
      };
      await mkdir(join(app.getPath('userData'), 'sessions', session.id, 'snapshots'), { recursive: true });
      await writeFile(
        join(app.getPath('userData'), 'sessions', session.id, 'snapshots', `${id}.json`),
        JSON.stringify(snapshot, null, 2),
        'utf8',
      );
      return snapshot;
    });
    ipcMain.handle(IPC.snapshotGet, async (_e, id: string): Promise<SessionSnapshot | null> => {
      const session = currentSession;
      if (!session) return null;
      try {
        const raw = await readFile(join(app.getPath('userData'), 'sessions', session.id, 'snapshots', `${id}.json`), 'utf8');
        return JSON.parse(raw) as SessionSnapshot;
      } catch {
        return null;
      }
    });
    ipcMain.handle(IPC.judgeRestart, async (): Promise<boolean> => {
      const session = currentSession;
      if (!session) return false;
      judgeHost?.kill();
      const sessionDir = join(app.getPath('userData'), 'sessions', session.id);
      const started = judgeHost?.spawn(
        session.id,
        sessionDir,
        session.judge?.cwd ?? app.getPath('home'),
      );
      if (!started) mainWindow?.webContents.send(IPC.judgeExit, { code: -1 });
      return started ?? false;
    });
    ipcMain.handle(IPC.scrollbackGet, async (_e, agentId: string): Promise<string[] | null> => {
      const session = currentSession;
      if (!session) return null;
      try {
        const raw = await readFile(
          join(app.getPath('userData'), 'sessions', session.id, 'scrollback', `${agentId}.json`),
          'utf8',
        );
        const parsed = JSON.parse(raw) as { lines?: string[] };
        return Array.isArray(parsed.lines) ? parsed.lines : null;
      } catch {
        return null;
      }
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
