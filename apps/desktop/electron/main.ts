import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { copyFile, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgentEnv } from './agent-env.js';
import { MailboxRouter, ORCHESTRATOR_ID, messageId } from './mailbox.js';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { ReviewerHost, type ReviewerToolCallEvent } from './reviewer.js';
import { ReviewerTools } from './reviewer-tools.js';
import { SessionRegistry, SessionRuntime } from './session-runtime.js';
import { SessionStore } from './sessions.js';
import { SettingsStore } from './settings.js';
import { TileRecorder } from './tile-recorder.js';
import {
  IPC,
  type AppInfo,
  type FsEntry,
  type FsStat,
  type OpenedSession,
  type PtySpawnArgs,
  type PtySpawnResult,
  type SendMessageArgs,
  type SessionFile,
  type SessionSavePayload,
  type SessionSnapshot,
  type Settings,
  type ReviewerEntry,
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
let currentTheme: ThemeId = 'midnight';
let registry: SessionRegistry | null = null;

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
        submenu: [
          { label: 'Open', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'open', id: s.id }) },
          { label: 'Stop', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'stop', id: s.id }) },
          { label: 'Start', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'start', id: s.id }) },
          { type: 'separator' },
          { label: 'Delete…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'delete', id: s.id }) },
        ],
      });
    }
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
  // the renderer would reset to zero tiles while the runtimes keep sessions.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => {
    registry?.killAll();
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
    const sessionsRoot = join(app.getPath('userData'), 'sessions');
    const home = app.getPath('home');

    const judgeCwdFor = (session: SessionFile): string =>
      session.projectPath ?? session.judge?.cwd ?? home;

    // one live runtime per session; created lazily on first visit
    registry = new SessionRegistry({
      sessionRoot: sessionsRoot,
      logger: (line) => console.log(line),
      makeRuntime: (session: SessionFile): SessionRuntime => {
        let rt: SessionRuntime | null = null;
        const recorder = new TileRecorder();
        const host = new PtyHost({
          send: (channel, tileId, payload) => {
            // the recording: every agent PTY chunk is teed into the
            // in-memory ring before being forwarded to the renderer
            if (channel === IPC.ptyData) recorder.record(tileId, payload as string);
            // keep-alive: every live session streams its events, tagged with
            // its sessionId; the renderer filters per mounted SessionView
            mainWindow?.webContents.send(channel, session.id, tileId, payload);
          },
        });
        const tileOfAgent = (agentId: string): string | null =>
          agentId === ORCHESTRATOR_ID ? null : (rt?.agentToTile.get(agentId) ?? null);
        const agentOfTile = (tileId: string): string | null => {
          for (const [agentId, tid] of rt?.agentToTile ?? []) {
            if (tid === tileId) return agentId;
          }
          return null;
        };
        const cwdOfAgent = (agentId: string): string | null =>
          rt?.session.tiles.find((t) => t.agentId === agentId)?.cwd ?? null;
        const router = new MailboxRouter({
          root: sessionsRoot,
          currentSession: () => rt?.session ?? session,
          tileOfAgent,
          write: (tileId, text) => host.write(tileId, text),
          emit: (msg) => {
            mainWindow?.webContents.send(IPC.messageEvent, session.id, msg);
            // agent results feed the reviewer harness as turns
            if (msg.to === ORCHESTRATOR_ID && msg.from !== ORCHESTRATOR_ID) {
              void rt?.reviewer.onAgentMessage(msg);
            }
          },
        });
        const tools = new ReviewerTools();
        const reviewer = new ReviewerHost({
          getConfig: () => settings.get().then((s) => s.reviewer),
          sessionId: session.id,
          sessionDir: join(sessionsRoot, session.id),
          cwd: judgeCwdFor(session),
          recorder,
          toolContext: {
            sessionId: session.id,
            sessionDir: join(sessionsRoot, session.id),
            cwd: judgeCwdFor(session),
            recorder,
            router: {
              sendFromOrchestrator: (msg) => router.sendFromOrchestrator(msg),
            },
            tileOfAgent,
            agentOfTile,
            cwdOfAgent,
          },
          tools,
          emit: {
            status: (status, error) =>
              mainWindow?.webContents.send(IPC.reviewerStatus, session.id, { status, error }),
            stream: (delta) => mainWindow?.webContents.send(IPC.reviewerStream, session.id, delta),
            toolCall: (ev: ReviewerToolCallEvent) =>
              mainWindow?.webContents.send(IPC.reviewerToolCall, session.id, ev),
            message: (entry) => mainWindow?.webContents.send(IPC.reviewerMessage, session.id, entry),
          },
          logger: (line) => console.log(line),
        });
        const runtime = new SessionRuntime({
          session,
          sessionRoot: sessionsRoot,
          host,
          reviewer,
          router,
          judgeCwd: () => judgeCwdFor(session),
        });
        rt = runtime;
        return runtime;
      },
    });

    const openSession = async (id: string): Promise<OpenedSession> => {
      const session = await sessions.load(id);
      const rt = registry!.open(id, session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };

    /** One in-flight project open per raw path: a double-click must not race
     *  into two session creations for the same project. Keyed before any
     *  await so concurrent clicks for the same path share one promise. */
    const pendingProjectOpens = new Map<string, Promise<OpenedSession>>();
    const openProjectSession = async (projectPath: string): Promise<OpenedSession> => {
      let project =
        (await projects.list()).find((p) => p.path === projectPath) ??
        (await projects.add(projectPath));
      if (project.sessionId) {
        try {
          return await openSession(project.sessionId);
        } catch {
          // stale binding (session deleted) — fall through and recreate
        }
      }
      const opened = await sessions.newSession(project.name);
      project = (await projects.bindSession(projectPath, opened.session.id)) ?? project;
      opened.session.projectPath = projectPath;
      opened.session.name = project.name;
      opened.session.judge = { command: '', cwd: projectPath };
      await sessions.save(opened.session);
      const rt = registry!.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };

    ipcMain.handle(IPC.appInfo, (): AppInfo => ({
      version: app.getVersion(),
      shell: process.env.SHELL ?? '/bin/bash',
      userData: app.getPath('userData'),
      home,
    }));
    ipcMain.handle(IPC.ptySpawn, async (_e, args: PtySpawnArgs): Promise<PtySpawnResult> => {
      const rt = registry?.get(args.sessionId) ?? null;
      const session = rt?.session ?? null;
      if (!rt || !session) throw new Error(`no runtime for session ${args.sessionId}`);
      // restore passes the persisted agentId; live spawns get a fresh one
      let agentId = args.agentId ?? null;
      if (agentId === null || !session.tiles.some((t) => t.agentId === agentId)) {
        agentId = sessions.allocateAgentId(session);
        session.tiles.push({ agentId, cwd: args.cwd });
        await sessions.save(session);
        rt.updateSession(session);
      }
      await sessions.ensureAgentMailbox(session.id, agentId);
      rt.agentToTile.set(agentId, args.tileId);
      const env = buildAgentEnv(session.id, agentId, 'agent', rt.sessionDir());
      try {
        rt.host.spawn(args.tileId, { cwd: args.cwd, cols: args.cols, rows: args.rows, envExt: env });
      } catch (err) {
        // a failed spawn must close the tile through the normal exit path,
        // otherwise the renderer would keep a dead tile forever
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        mainWindow?.webContents.send(IPC.tileExit, session.id, args.tileId, { code: -1 });
      }
      return { agentId };
    });
    ipcMain.on(IPC.ptyWrite, (_e, sessionId: string, tileId: string, data: string) => {
      registry?.get(sessionId)?.host.write(tileId, data);
    });
    ipcMain.on(IPC.ptyResize, (_e, sessionId: string, tileId: string, cols: number, rows: number) => {
      registry?.get(sessionId)?.host.resize(tileId, cols, rows);
    });
    ipcMain.on(IPC.ptyKill, (_e, sessionId: string, tileId: string) => {
      registry?.get(sessionId)?.host.kill(tileId);
    });

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
      if (THEME_IDS.includes(next.theme as ThemeId)) {
        currentTheme = next.theme as ThemeId;
        refreshMenu();
      }
      return next;
    });
    ipcMain.handle(IPC.sessionsList, async () => {
      const list = await sessions.list();
      return list.map((s) => ({ ...s, state: registry?.get(s.id)?.state ?? 'stopped' }));
    });
    ipcMain.handle(IPC.sessionNew, async (_e, name: string): Promise<OpenedSession> => {
      const opened = await sessions.newSession(name);
      const rt = registry!.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    });
    ipcMain.handle(IPC.sessionSaveAs, async (_e, id: string, name: string) => {
      const session = await sessions.rename(id, name);
      registry?.get(id)?.updateSession(session);
      refreshMenu();
      return session;
    });
    ipcMain.handle(IPC.sessionOpen, (_e, id: string) => openSession(id));
    ipcMain.handle(IPC.sessionDelete, async (_e, id: string) => {
      registry?.teardown(id);
      await sessions.delete(id);
      refreshMenu();
    });
    ipcMain.handle(IPC.sessionStop, (_e, id: string) => registry?.stop(id));
    ipcMain.handle(IPC.sessionStart, (_e, id: string) => registry?.start(id));
    ipcMain.handle(IPC.projectOpen, async (_e, path: string): Promise<OpenedSession> => {
      const pending = pendingProjectOpens.get(path);
      if (pending) return pending;
      const p = (async (): Promise<OpenedSession> => {
        const project = await projects.add(path);
        return openProjectSession(project.path);
      })();
      pendingProjectOpens.set(path, p);
      try {
        return await p;
      } finally {
        pendingProjectOpens.delete(path);
      }
    });
    ipcMain.handle(IPC.sessionSave, async (_e, sessionId: string, payload: SessionSavePayload) => {
      const rt = registry?.get(sessionId) ?? null;
      const session = rt?.session ?? null;
      if (!session) return null;
      // a stopped session's view empties out as its PTYs die; its saves are
      // stop artifacts and must not clobber the persisted arrangement
      if (rt?.state === 'stopped') return session;
      session.tree = payload.tree;
      // null clears the persisted value (user unzoomed/unfocused), undefined
      // means "not part of this payload"
      if (payload.zoomedAgentId !== undefined) session.zoomedAgentId = payload.zoomedAgentId ?? undefined;
      if (payload.focusedAgentId !== undefined) session.focusedAgentId = payload.focusedAgentId ?? undefined;
      if (payload.judgeCwd) session.judge = { command: '', cwd: payload.judgeCwd };
      // prunes agents closed since the last save; mailboxes stay on disk
      session.tiles = session.tiles.filter((t) => payload.agents.includes(t.agentId));
      await sessions.save(session);
      rt?.updateSession(session);
      if (payload.scrollback) {
        const sessionDir = rt?.sessionDir() ?? join(sessionsRoot, session.id);
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
    ipcMain.handle(IPC.messageSend, async (_e, sessionId: string, args: SendMessageArgs): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to: args.to,
        kind: args.kind,
        body: args.body,
        ref: args.ref,
        at: Date.now(),
      });
    });
    ipcMain.handle(IPC.messageList, async (_e, sessionId: string) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.router.listMessages(rt.session.id);
    });
    ipcMain.handle(IPC.snapshotCreate, async (_e, sessionId: string, args: { agentId: string; text: string }): Promise<SessionSnapshot> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) throw new Error('no session runtime');
      const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const snapshot: SessionSnapshot = {
        id,
        agentId: args.agentId,
        at: Date.now(),
        lineCount: args.text.length > 0 ? args.text.split('\n').length : 0,
        text: args.text,
      };
      await mkdir(join(rt.sessionDir(), 'snapshots'), { recursive: true });
      await writeFile(
        join(rt.sessionDir(), 'snapshots', `${id}.json`),
        JSON.stringify(snapshot, null, 2),
        'utf8',
      );
      return snapshot;
    });
    ipcMain.handle(IPC.snapshotGet, async (_e, sessionId: string, id: string): Promise<SessionSnapshot | null> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return null;
      try {
        const raw = await readFile(join(rt.sessionDir(), 'snapshots', `${id}.json`), 'utf8');
        return JSON.parse(raw) as SessionSnapshot;
      } catch {
        return null;
      }
    });
    ipcMain.handle(IPC.reviewerEnsure, async (_e, sessionId: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.ensureReviewer();
    });
    ipcMain.handle(IPC.reviewerPrompt, async (_e, sessionId: string, text: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt || text.trim().length === 0) return;
      await rt.reviewer.prompt(text);
    });
    ipcMain.handle(IPC.reviewerStop, async (_e, sessionId: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.cancel();
    });
    ipcMain.handle(IPC.reviewerRestart, async (_e, sessionId: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.reviewer.restart();
    });
    ipcMain.handle(IPC.reviewerTranscript, async (_e, sessionId: string): Promise<ReviewerEntry[]> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.reviewer.conversation;
    });
    ipcMain.handle(IPC.scrollbackGet, async (_e, sessionId: string, agentId: string): Promise<string[] | null> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return null;
      try {
        const raw = await readFile(join(rt.sessionDir(), 'scrollback', `${agentId}.json`), 'utf8');
        const parsed = JSON.parse(raw) as { lines?: string[] };
        return Array.isArray(parsed.lines) ? parsed.lines : null;
      } catch {
        return null;
      }
    });

    // file editor backend
    ipcMain.handle(IPC.fsListDir, async (_e, path: string): Promise<FsEntry[]> => {
      const entries = await readdir(path, { withFileTypes: true });
      const out: FsEntry[] = [];
      for (const e of entries) {
        const full = join(path, e.name);
        let isDir = e.isDirectory();
        let size = 0;
        try {
          if (e.isSymbolicLink()) {
            const st = await stat(full);
            isDir = st.isDirectory();
            size = st.size;
          } else if (!isDir) {
            size = (await stat(full)).size;
          }
        } catch {
          // broken symlink or unreadable entry — skip it
          continue;
        }
        out.push({ name: e.name, path: full, isDir, size });
      }
      out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return out;
    });
    ipcMain.handle(IPC.fsReadFile, async (_e, path: string): Promise<{ content: string; size: number }> => {
      const st = await stat(path);
      if (st.size > 4 * 1024 * 1024) throw new Error('file too large');
      return { content: await readFile(path, 'utf8'), size: st.size };
    });
    ipcMain.handle(IPC.fsWriteFile, async (_e, path: string, content: string): Promise<void> => {
      await writeFile(path, content, 'utf8');
    });
    ipcMain.handle(IPC.fsStat, async (_e, path: string): Promise<FsStat> => {
      const st = await stat(path);
      return { path, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
    });

    ipcMain.handle(IPC.pickFolder, async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Add a project folder',
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    app.on('will-quit', () => registry?.killAll());

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
