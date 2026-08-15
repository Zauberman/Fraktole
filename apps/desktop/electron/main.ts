import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import { copyFile, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAgentEnv } from './agent-env.js';
import { MailboxRouter, ORCHESTRATOR_ID, messageId } from './mailbox.js';
import { listModels } from './model-list.js';
import { PtyHost } from './pty-host.js';
import { ProjectsStore } from './projects.js';
import { RemoteBridge, lanIps } from './remote/bridge.js';
import type { RemoteBackend, SessionRow, TileRow, MessageRow } from './remote/backend.js';
import { RemoteStore } from './remote/store.js';
import { ReviewerHost, type ReviewerToolCallEvent } from './reviewer.js';
import { AUTONOMY_VARIANTS, type AutonomyVariant } from './reviewer-plugins.js';
import { forkProject } from './fork.js';
import { ReviewerTools } from './reviewer-tools.js';
import { exportSessionBundle, importSessionBundle, type BundleResult } from './session-bundle.js';
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
  type RemoteStatus,
  type SendMessageArgs,
  type SessionFile,
  type SessionSavePayload,
  type SessionSnapshot,
  type Settings,
  type ReviewerEntry,
  type ReviewerSpawnRequest,
  type TestPageState,
} from '../src/shared/ipc.js';
import { THEME_IDS, type ThemeId } from '../src/themes.js';

// Consistent identity across dev, local install and packaged builds: WM_CLASS,
// window association and the userData directory all key off the app name.
app.setName('Fraktole');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';

async function waitForDevServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // each attempt gets its own deadline so a stalled connection can never
    // hang the boot sequence past the overall timeout
    const controller = new AbortController();
    const attemptTimer = setTimeout(() => controller.abort(), 1_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) return;
    } catch {
      // server not up yet — keep polling
    } finally {
      clearTimeout(attemptTimer);
    }
    if (Date.now() > deadline) throw new Error(`dev server unreachable at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let mainWindow: BrowserWindow | null = null;
let currentTheme: ThemeId = 'midnight';
let registry: SessionRegistry | null = null;
/** In-flight reviewer spawns awaiting the renderer's tile mount. */
const pendingSpawns = new Map<string, { agentId: string; resolve(out: string): void }>();
/**
 * Settles the pending spawn for an agent with a final verdict. Called from
 * the ptySpawn outcome (success or failure) — never from the mount ack,
 * which only proves the renderer mounted a tile, not that the PTY lives.
 */
function settlePendingSpawn(agentId: string, out: string): void {
  for (const [requestId, pending] of pendingSpawns) {
    if (pending.agentId === agentId) {
      pendingSpawns.delete(requestId);
      pending.resolve(out);
      return;
    }
  }
}
/** In-flight test-page reads/screenshots awaiting the renderer. */
const pendingTestReads = new Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>();
const pendingTestShots = new Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>();
/** Per-session background-job registries (stopped with the session). */
let testSeq = 0;

/** Per-session live infra the remote bridge reads: the PTY recorder and the
 *  set of live tile ids (fed by the ptyData/tileExit send hook). */
const sessionInfra = new Map<string, { recorder: TileRecorder; alive: Set<string> }>();
/** Durable agentId → tile kind ('agent' launcher vs plain 'shell'). */
const agentKinds = new Map<string, 'agent' | 'shell' | 'reviewer'>();

function testRoundTrip(
  map: Map<string, { resolve(out: string): void; timer: NodeJS.Timeout }>,
  channel: string,
  sessionId: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const requestId = `test-${Date.now()}-${++testSeq}`;
    const timer = setTimeout(() => {
      map.delete(requestId);
      resolve('error: the Test tab did not respond');
    }, 8_000);
    map.set(requestId, { resolve, timer });
    mainWindow?.webContents.send(channel, sessionId, { requestId });
  });
}

/** Guest-browser policy: window.open / target=_blank from a tested page
 *  navigates in-tab (the user chose all-in-tab behavior); guests never get
 *  the shell's preload or bridge. */
function wireGuestPolicy(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      void contents.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
  });
}

/** Custom application menu: File → New Tile/Sessions/Quit, View → Theme.
 *  The default Electron menu would expose Reload (orphaning every PTY) and
 *  DevTools in production. Session actions are forwarded to the renderer,
 *  which owns the save/switch flows (it holds the live workspace state). */
function buildMenu(currentTheme: ThemeId, sessions: Array<{ id: string; name: string }>): Menu {
  const sessionItems: Electron.MenuItemConstructorOptions[] = [
    { label: 'New Session…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'new' }) },
    { label: 'Save As…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'save-as' }) },
    { label: 'Rename…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'rename' }) },
    { type: 'separator' },
    { label: 'Export Session Bundle…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'export-bundle' }) },
    { label: 'Import Session Bundle…', click: () => mainWindow?.webContents.send(IPC.menuSession, { action: 'import-bundle' }) },
  ];
  if (sessions.length > 0) {
    sessionItems.push({ type: 'separator' });
    for (const s of sessions) {
      sessionItems.push({
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
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'Session',
      submenu: sessionItems,
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
      // the Test tab embeds a sandboxed guest browser
      webviewTag: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  // a closed window must never keep being the send target: webContents.send
  // on a destroyed window throws (macOS keeps the app alive without a window)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

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
  // a second launch (app menu, desktop entry, repeated command) while an
  // instance is already running: quit silently — the first instance is
  // told to come forward by the second-instance event below
  app.quit();
} else {
  // bring the existing window forward (shared by the second-instance event
  // and the launcher's SIGUSR2 when it detects a running instance)
  const focusApp = (): void => {
    if (!mainWindow) return;
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  app.on('second-instance', focusApp);
  // the launcher sends this instead of spawning a doomed second Electron
  // (whose zygotes would leak as orphans); some args-bearing launches still
  // fall through to the second-instance event above
  process.on('SIGUSR2', focusApp);

  app.whenReady().then(async () => {
    wireGuestPolicy();
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
        const alive = new Set<string>();
        sessionInfra.set(session.id, { recorder, alive });
        // ptyData chunks are coalesced per tile per tick: one IPC send and
        // one remote publish per tick instead of per chunk
        const pendingChunks = new Map<string, { sessionId: string; tileId: string; chunks: string[] }>();
        let flushScheduled = false;
        const flushTile = (key: string): void => {
          const entry = pendingChunks.get(key);
          if (!entry || entry.chunks.length === 0) return;
          pendingChunks.delete(key);
          const data = entry.chunks.join('');
          entry.chunks.length = 0;
          recorder.record(entry.tileId, data);
          alive.add(entry.tileId);
          remote?.publish({
            type: 'tile.output',
            sessionId: entry.sessionId,
            tileId: entry.tileId,
            data,
            ts: Date.now(),
          });
          mainWindow?.webContents.send(IPC.ptyData, entry.sessionId, entry.tileId, data);
        };
        const flushChunks = (): void => {
          flushScheduled = false;
          for (const key of [...pendingChunks.keys()]) flushTile(key);
        };
        const enqueueChunk = (sessionId: string, tileId: string, data: string): void => {
          const key = `${sessionId}\u0000${tileId}`;
          const entry = pendingChunks.get(key) ?? { sessionId, tileId, chunks: [] };
          entry.chunks.push(data);
          pendingChunks.set(key, entry);
          if (!flushScheduled) {
            flushScheduled = true;
            setImmediate(flushChunks);
          }
        };
        const host = new PtyHost({
          send: (channel, tileId, payload) => {
            if (channel === IPC.ptyData) {
              // the recording: every agent PTY chunk is teed into the
              // in-memory ring before being forwarded to the renderer
              enqueueChunk(session.id, tileId, payload as string);
            } else if (channel === IPC.tileExit) {
              // order matters: pending output must reach the renderer before
              // the exit event that closes the tile
              flushTile(`${session.id}\u0000${tileId}`);
              alive.delete(tileId);
              const lines = recorder.summary(tileId).lines;
              recorder.drop(tileId);
              for (const [agentId, tid] of [...(rt?.agentToTile ?? [])]) {
                if (tid === tileId) rt?.agentToTile.delete(agentId);
              }
              remote?.publish({
                type: 'tile.state',
                sessionId: session.id,
                tileId,
                alive: false,
                lines,
              });
            }
            // keep-alive: every live session streams its events, tagged with
            // its sessionId; the renderer filters per mounted SessionView
            if (channel === IPC.tileExit) {
              mainWindow?.webContents.send(channel, session.id, tileId, payload);
            }
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
            remote?.publish({
              type: 'message.new',
              sessionId: session.id,
              msg: { kind: msg.kind, from: msg.from, to: msg.to, body: msg.body, ts: msg.at },
            });
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
          forkProject: (variant) => {
            if (!rt) return Promise.resolve({ ok: false as const, error: 'no runtime for session' });
            const src = judgeCwdFor(rt.session);
            return forkProject(src, join(src, '.fraktole-auto', variant), home);
          },
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
            killAgent: async (tileId) => {
              host.kill(tileId);
              return `killed ${tileId}`;
            },
            agentCount: () => rt?.session.tiles.length ?? 0,
            spawnAgent: async (kind, cwd) => {
              if (!rt) return 'error: no runtime for session';
              const res = await spawnAgentInSession(rt, kind, cwd);
              return res.ok ? `spawned agent ${res.agentId}` : res.error;
            },
            openTestPage: async (url) => {
              if (!rt) return 'error: no runtime for session';
              const target = typeof url === 'string' ? url.trim() : '';
              if (target.length === 0) return 'error: url required';
              mainWindow?.webContents.send(IPC.testOpen, rt.session.id, { url: target });
              return `opened ${target} in the Test tab`;
            },
            readTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              return testRoundTrip(pendingTestReads, IPC.testStateRequest, rt.session.id);
            },
            screenshotTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              return testRoundTrip(pendingTestShots, IPC.testScreenshotRequest, rt.session.id);
            },
            reloadTestPage: () => {
              if (!rt) return Promise.resolve('error: no runtime for session');
              mainWindow?.webContents.send(IPC.testReload, rt.session.id);
              return Promise.resolve('reload sent to the Test tab');
            },
            listMessages: () => router.listMessages(session.id),
            writeToAgent: (agentId, command) => {
              if (agentId === ORCHESTRATOR_ID) return Promise.resolve('error: the orchestrator is not an agent tile');
              const tileId = tileOfAgent(agentId);
              if (!tileId) return Promise.resolve(`error: unknown agent ${agentId}`);
              host.write(tileId, `${command}\n`);
              return Promise.resolve(`launched "${command}" in ${agentId}`);
            },
          },
          tools,
          emit: {
            status: (status, error, model, variant) =>
              mainWindow?.webContents.send(IPC.reviewerStatus, session.id, { status, error, model, variant }),
            stream: (ev) => mainWindow?.webContents.send(IPC.reviewerStream, session.id, ev),
            toolCall: (ev: ReviewerToolCallEvent) =>
              mainWindow?.webContents.send(IPC.reviewerToolCall, session.id, ev),
            message: (entry) => mainWindow?.webContents.send(IPC.reviewerMessage, session.id, entry),
            goal: (ev) => mainWindow?.webContents.send(IPC.reviewerGoal, session.id, ev),
            question: (ev) => mainWindow?.webContents.send(IPC.reviewerQuestion, session.id, ev),
            usage: (ev) => mainWindow?.webContents.send(IPC.reviewerUsage, session.id, ev),
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

    /** One in-flight project open per resolved project root (git toplevel):
     *  a double-click must not race into two session creations for the same
     *  project, and two paths inside the same repo must dedupe onto one. */
    const pendingProjectOpens = new Map<string, Promise<OpenedSession>>();
    /** Serializes project opens so the resolve-then-check-then-set window
     *  cannot interleave across concurrent opens of the same root. */
    let projectOpenQueue: Promise<unknown> = Promise.resolve();

    /**
     * Spawns a new agent tile in a session's runtime: allocates the durable
     * agentId, persists the tile, and asks the renderer to mount it. Shared
     * by the reviewer harness (spawn_agent tool) and the remote bridge
     * (agent.spawn RPC). Resolves once the renderer reports the tile.
     */
    const spawnAgentInSession = async (
      rt: SessionRuntime,
      kind: string | undefined,
      cwd: string,
    ): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> => {
      const target = cwd.length > 0 ? cwd : judgeCwdFor(rt.session);
      // cwd arrives from the phone via agent.spawn — refuse anything that is
      // not an existing directory instead of spawning a shell elsewhere
      if (cwd.length > 0) {
        try {
          if (!(await stat(target)).isDirectory()) return { ok: false, error: 'cwd is not a directory' };
        } catch {
          return { ok: false, error: 'cwd does not exist' };
        }
      }
      const agentId = sessions.allocateAgentId(rt.session);
      const tileKind: 'agent' | 'shell' = kind && kind !== 'shell' ? 'agent' : 'shell';
      rt.session.tiles.push({ agentId, cwd: target, kind: tileKind });
      agentKinds.set(agentId, tileKind);
      const requestId = `spawn-${Date.now()}-${agentId}`;
      let persisted = false;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawns.delete(requestId);
          // roll back the phantom tile so a timed-out spawn cannot linger
          // as a ghost agent that resurrects on the next save/restore
          if (!persisted) rt.session.nextAgentSeq -= 1;
          rt.session.tiles = rt.session.tiles.filter((t) => t.agentId !== agentId);
          agentKinds.delete(agentId);
          void sessions
            .save(rt.session)
            .then(() => rt.updateSession(rt.session))
            .catch(() => undefined);
          resolve({ ok: false, error: `spawn timed out — the renderer never mounted tile for ${agentId}` });
        }, 20_000);
        pendingSpawns.set(requestId, {
          agentId,
          resolve: (out) => {
            // the verdict arrives from the ptySpawn outcome (success or error)
            clearTimeout(timer);
            if (out.startsWith('error')) resolve({ ok: false, error: out });
            else resolve({ ok: true, agentId });
          },
        });
        void sessions
          .save(rt.session)
          .then(() => {
            persisted = true;
          })
          .then(() => sessions.ensureAgentMailbox(rt.session.id, agentId))
          .then(() => {
            rt.updateSession(rt.session);
            mainWindow?.webContents.send(IPC.reviewerSpawnRequest, {
              sessionId: rt.session.id,
              requestId,
              agentId,
              cwd: target,
              command: kind === 'shell' ? undefined : kind,
            } satisfies ReviewerSpawnRequest);
          })
          .catch((err: unknown) => {
            pendingSpawns.delete(requestId);
            clearTimeout(timer);
            if (!persisted) rt.session.nextAgentSeq -= 1;
            rt.session.tiles = rt.session.tiles.filter((t) => t.agentId !== agentId);
            agentKinds.delete(agentId);
            resolve({ ok: false, error: `error: ${(err as Error).message}` });
          });
      });
    };
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
      // agent ids are internally generated agent-<n>: anything else must
      // never reach mailbox paths (agents dir, env contract)
      if (args.agentId !== undefined && (typeof args.agentId !== 'string' || !/^agent-\d+$/.test(args.agentId))) {
        throw new Error(`invalid agent id ${args.agentId}`);
      }
      // restore passes the persisted agentId; live spawns get a fresh one
      let agentId = args.agentId ?? null;
      if (agentId === null || !session.tiles.some((t) => t.agentId === agentId)) {
        agentId = sessions.allocateAgentId(session);
        session.tiles.push({ agentId, cwd: args.cwd });
        try {
          await sessions.save(session);
        } catch (err) {
          // the id was never persisted: roll the in-memory state back so a
          // retry reuses it instead of burning the sequence
          session.tiles = session.tiles.filter((t) => t.agentId !== agentId);
          session.nextAgentSeq -= 1;
          throw err;
        }
        rt.updateSession(session);
      } else {
        // restore: keep the tile record in sync with the spawn cwd and kind
        session.tiles = session.tiles.map((t) =>
          t.agentId === agentId ? { ...t, cwd: args.cwd, kind: args.command && args.command.trim().length > 0 ? 'agent' : t.kind } : t,
        );
        await sessions.save(session);
        rt.updateSession(session);
      }
      // launcher command present ⇒ an agent tile, otherwise a plain shell
      // (restored tiles fall back to their persisted kind)
      const persistedKind = session.tiles.find((t) => t.agentId === agentId)?.kind;
      agentKinds.set(agentId, args.command && args.command.trim().length > 0 ? 'agent' : (persistedKind ?? 'shell'));
      await sessions.ensureAgentMailbox(session.id, agentId);
      rt.agentToTile.set(agentId, args.tileId);
      const env = buildAgentEnv(session.id, agentId, 'agent', rt.sessionDir());
      try {
        rt.host.spawn(args.tileId, { cwd: args.cwd, cols: args.cols, rows: args.rows, envExt: env });
        if (args.command && args.command.trim().length > 0) {
          rt.host.write(args.tileId, `${args.command.trim()}\n`);
        }
        // the PTY is genuinely alive now — the reviewer's spawn verdict is real
        settlePendingSpawn(agentId, `spawned agent ${agentId} (tile ${args.tileId})`);
      } catch (err) {
        // a failed spawn must surface as a spawn error to the reviewer, not
        // a success that the renderer mount ack already reported
        settlePendingSpawn(agentId, `error: pty spawn failed for ${args.tileId}: ${(err as Error).message}`);
        // a failed spawn must close the tile through the normal exit path,
        // otherwise the renderer would keep a dead tile forever — and the
        // phantom tile state must not linger to resurrect on the next save
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        rt.agentToTile.delete(agentId);
        agentKinds.delete(agentId);
        session.tiles = session.tiles.filter((t) => t.agentId !== agentId);
        try {
          await sessions.save(session);
          rt.updateSession(session);
        } catch {
          // best-effort cleanup
        }
        mainWindow?.webContents.send(IPC.tileExit, session.id, args.tileId, { code: -1 });
      }
      return { agentId };
    });
    ipcMain.on(IPC.ptyWrite, (_e, sessionId: string, tileId: string, data: string) => {
      if (typeof data !== 'string') return;
      registry?.get(sessionId)?.host.write(tileId, data);
    });
    ipcMain.on(IPC.ptyResize, (_e, sessionId: string, tileId: string, cols: number, rows: number) => {
      if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      registry?.get(sessionId)?.host.resize(tileId, cols, rows);
    });
    ipcMain.on(IPC.ptyKill, (_e, sessionId: string, tileId: string) => {
      if (typeof sessionId !== 'string' || typeof tileId !== 'string') return;
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
    // programmatic theme switch — persists and re-broadcasts through the
    // exact native-menu path (used by the E2E driver's theme walk)
    ipcMain.handle(IPC.themeApply, async (_e, id: unknown) => {
      if (typeof id !== 'string' || !THEME_IDS.includes(id as ThemeId)) return;
      const next = await settings.set({ theme: id as ThemeId });
      currentTheme = next.theme as ThemeId;
      refreshMenu();
      mainWindow?.webContents.send(IPC.menuTheme, id);
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
      sessionInfra.delete(id);
      await sessions.delete(id);
      refreshMenu();
    });
    ipcMain.handle(IPC.sessionStop, (_e, id: string) => {
      registry?.stop(id);
      remote?.publish({ type: 'session.state', sessionId: id, alive: false });
    });
    ipcMain.handle(IPC.sessionStart, (_e, id: string) => {
      registry?.start(id);
      remote?.publish({ type: 'session.state', sessionId: id, alive: true });
    });
    ipcMain.handle(IPC.sessionExportBundle, async (_e, id: string): Promise<BundleResult> => {
      const session = await sessions.load(id).catch(() => null);
      const base = (session?.name ?? id).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
      const picked = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export session bundle',
        defaultPath: `fraktole-session-${base}.tar.gz`,
        filters: [{ name: 'Fraktole session bundle', extensions: ['tar.gz'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false as const, canceled: true as const, error: '' };
      return exportSessionBundle(sessionsRoot, id, picked.filePath);
    });
    ipcMain.handle(IPC.sessionImportBundle, async (): Promise<BundleResult> => {
      const picked = await dialog.showOpenDialog(mainWindow!, {
        title: 'Import session bundle',
        filters: [{ name: 'Fraktole session bundle', extensions: ['tar.gz'] }],
        properties: ['openFile'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: false as const, canceled: true as const, error: '' };
      }
      const res = await importSessionBundle(sessionsRoot, picked.filePaths[0]!);
      if (!res.ok || !res.session) return res;
      registry!.open(res.session.id, res.session);
      refreshMenu();
      return { ok: true as const, session: res.session };
    });
    ipcMain.handle(IPC.projectOpen, (_e, path: string): Promise<OpenedSession> => {
      const run = projectOpenQueue.then(async (): Promise<OpenedSession> => {
        const project = await projects.add(path);
        // key by the resolved root (git toplevel), not the raw path
        const key = project.path;
        const pending = pendingProjectOpens.get(key);
        if (pending) return pending;
        const p = openProjectSession(key);
        pendingProjectOpens.set(key, p);
        try {
          return await p;
        } finally {
          pendingProjectOpens.delete(key);
        }
      });
      projectOpenQueue = run.catch(() => undefined);
      return run;
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
      // an explicit judgeCwd (including null/'') is the clear signal; an
      // undefined payload means "not part of this save"
      if (payload.judgeCwd !== undefined) {
        session.judge = payload.judgeCwd && payload.judgeCwd.length > 0 ? { command: '', cwd: payload.judgeCwd } : null;
      }
      // prunes agents closed since the last save; mailboxes stay on disk
      if (!Array.isArray(payload.agents)) return session;
      const kept = new Set(payload.agents);
      session.tiles = session.tiles.filter((t) => kept.has(t.agentId));
      for (const agentId of [...(rt?.agentToTile.keys() ?? [])]) {
        if (!kept.has(agentId)) rt?.agentToTile.delete(agentId);
      }
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
      if (typeof args !== 'object' || args === null) return false;
      if (typeof args.to !== 'string' || args.to.length === 0 || typeof args.body !== 'string') return false;
      // cap the body so one oversized send cannot flood the log and terminal
      const body = args.body.length > 64 * 1024 ? args.body.slice(0, 64 * 1024) : args.body;
      return rt.router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to: args.to,
        kind: args.kind,
        body,
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
      if (typeof args !== 'object' || args === null) throw new Error('invalid snapshot args');
      if (typeof args.agentId !== 'string' || typeof args.text !== 'string') throw new Error('invalid snapshot args');
      // cap the text so one oversized snapshot cannot bloat disk and memory
      if (args.text.length > 512 * 1024) throw new Error('snapshot text too large');
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
    ipcMain.handle(IPC.reviewerPrompt, async (_e, sessionId: string, text: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt || text.trim().length === 0) return false;
      return rt.reviewer.prompt(text);
    });
    ipcMain.handle(IPC.reviewerSetGoal, async (_e, sessionId: string, text: string | null): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      await rt?.reviewer.setGoal(typeof text === 'string' && text.trim().length > 0 ? text.trim() : null);
    });
    ipcMain.handle(IPC.reviewerAutonomy, async (_e, sessionId: string, variant: unknown): Promise<{ ok: boolean; error?: string }> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return { ok: false, error: 'no session runtime' };
      if (variant === null || variant === undefined) {
        await rt.reviewer.setVariant(null);
        return { ok: true };
      }
      if (typeof variant !== 'string' || !AUTONOMY_VARIANTS.includes(variant as AutonomyVariant)) {
        return { ok: false, error: 'unknown autonomous variant' };
      }
      return rt.reviewer.startAutonomy(variant as AutonomyVariant);
    });
    ipcMain.handle(IPC.reviewerAnswer, async (_e, sessionId: string, askId: string, answer: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.answerQuestion(askId, answer);
    });
    ipcMain.handle(IPC.reviewerKillNow, async (_e, sessionId: string, agentId: string): Promise<string> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return 'error: no runtime for session';
      return rt.reviewer.killAgentNow(agentId);
    });
    ipcMain.handle(
      IPC.reviewerSpawnResult,
      async (_e, sessionId: string, requestId: string, payload: { tileId: string | null; agentId: string | null }): Promise<void> => {
        const pending = pendingSpawns.get(requestId);
        if (!pending) {
          // late mount for an already-timed-out spawn: drop the phantom
          // tile so it cannot resurrect on the next save/restore
          if (payload?.agentId && sessionId) {
            const rt = registry?.get(sessionId) ?? null;
            if (rt) {
              rt.session.tiles = rt.session.tiles.filter((t) => t.agentId !== payload.agentId);
              agentKinds.delete(payload.agentId);
              try {
                await sessions.save(rt.session);
                rt.updateSession(rt.session);
              } catch {
                // best-effort cleanup
              }
            }
          }
          return;
        }
        if (!payload?.tileId) {
          // the renderer could not mount the tile — fail immediately
          pendingSpawns.delete(requestId);
          pending.resolve(`error: the renderer could not mount the tile for ${payload?.agentId ?? '?'}`);
          return;
        }
        // Mount succeeded — keep the pending spawn open: the "spawned" verdict
        // must wait for the real PTY spawn (ptySpawn). Resolving here would
        // report a false success before the shell actually exists, and a
        // failed ptySpawn would leave the reviewer believing an agent lives.

      },
    );
    ipcMain.handle(
      IPC.testState,
      async (_e, sessionId: string, requestId: string, state: TestPageState): Promise<void> => {
        const pending = pendingTestReads.get(requestId);
        if (!pending) return;
        pendingTestReads.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(
          JSON.stringify({
            url: state.url,
            title: state.title,
            loading: state.loading,
            consoleErrors: state.consoleErrors,
            console: (state.console ?? []).slice(-20),
          }),
        );
      },
    );
    ipcMain.handle(
      IPC.testScreenshot,
      async (_e, sessionId: string, requestId: string, dataUrl: string | null): Promise<void> => {
        const pending = pendingTestShots.get(requestId);
        if (!pending) return;
        pendingTestShots.delete(requestId);
        clearTimeout(pending.timer);
        if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
          pending.resolve('error: the test tab is not visible — open it first (open_test_page)');
          return;
        }
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const buf = Buffer.from(base64, 'base64');
        if (buf.length > 8 * 1024 * 1024) {
          pending.resolve('error: screenshot too large');
          return;
        }
        const rt = registry?.get(sessionId) ?? null;
        if (!rt) {
          pending.resolve('error: no runtime for session');
          return;
        }
        const shotsDir = join(rt.sessionDir(), 'reviewer', 'shots');
        await mkdir(shotsDir, { recursive: true });
        const file = join(shotsDir, `shot-${Date.now()}.png`);
        try {
          await writeFile(file, buf);
          pending.resolve(`saved ${file} (${buf.length} bytes)`);
        } catch (err) {
          pending.resolve(`error: ${(err as Error).message}`);
        }
      },
    );
    ipcMain.handle(IPC.reviewerStop, async (_e, sessionId: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.cancel();
    });
    ipcMain.handle(IPC.reviewerRestart, async (_e, sessionId: string): Promise<boolean> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.reviewer.restart();
    });
    ipcMain.handle(IPC.reviewerCompact, async (_e, sessionId: string): Promise<void> => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.compact();
    });
    ipcMain.handle(IPC.reviewerTranscript, async (_e, sessionId: string): Promise<ReviewerEntry[]> => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.reviewer.conversation;
    });
    ipcMain.handle(
      IPC.reviewerListModels,
      async (_e, opts: { adapter: 'openai' | 'anthropic' | 'ollama'; apiKey: string; baseUrl: string }): Promise<string[]> => {
        const key = typeof opts?.apiKey === 'string' ? opts.apiKey.trim() : '';
        if (opts?.adapter !== 'ollama' && key.length === 0) return [];
        return listModels({ adapter: opts.adapter, apiKey: key, baseUrl: typeof opts?.baseUrl === 'string' ? opts.baseUrl : '' });
      },
    );
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

    // terminal copy/paste: the native clipboard, not the renderer's
    // permission-gated navigator.clipboard
    ipcMain.handle(IPC.clipboardWrite, (_e, text: string): void => {
      clipboard.writeText(String(text));
    });
    ipcMain.handle(IPC.clipboardRead, (): string => clipboard.readText());

    // ————— remote bridge (docs/remote-protocol.md) —————

    const remoteStore = new RemoteStore(join(app.getPath('userData'), 'remote'));
    let remote: RemoteBridge | null = null;
    /** Last bridge start failure, surfaced in the Remote tab. */
    let remoteError: string | null = null;

    const liveTileOf = (agentId: string): { recorder: TileRecorder; tileId: string } | null => {
      for (const rt of registry?.all() ?? []) {
        const tileId = rt.agentToTile.get(agentId);
        if (tileId) {
          const infra = sessionInfra.get(rt.id);
          if (infra) return { recorder: infra.recorder, tileId };
        }
      }
      return null;
    };

    /** On-disk scrollback fallback for tiles with no live runtime. */
    const readDiskScrollback = async (agentId: string, tail: number): Promise<string> => {
      // agentId comes from the phone — keep it a single path component so it
      // can never traverse out of the session scrollback dir (the live path
      // above is a map lookup and cannot traverse, this one builds a path)
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(agentId)) {
        return '';
      }
      const list = await sessions.list();
      for (const s of list) {
        if (!(await sessions.listAgentIds(s.id)).includes(agentId)) continue;
        try {
          const raw = await readFile(join(sessionsRoot, s.id, 'scrollback', `${agentId}.json`), 'utf8');
          const parsed = JSON.parse(raw) as { lines?: string[] };
          const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
          return lines.slice(Math.max(0, lines.length - tail)).join('\n');
        } catch {
          return '';
        }
      }
      return '';
    };

    const readScrollback = async (agentId: string, tail = 500): Promise<string> => {
      const live = liveTileOf(agentId);
      if (live) return live.recorder.tail(live.tileId, tail).join('\n');
      return readDiskScrollback(agentId, tail);
    };

    const activeRuntime = (): SessionRuntime | null => {
      const id = registry?.active ?? null;
      return id ? (registry?.get(id) ?? null) : null;
    };

    const runtimeOfAgent = (agentId: string): SessionRuntime | null => {
      for (const rt of registry?.all() ?? []) {
        if (rt.session.tiles.some((t) => t.agentId === agentId)) return rt;
      }
      return null;
    };

    const makeRemoteBackend = (): RemoteBackend => ({
      serverName: 'Fraktole',
      version: app.getVersion(),
      listSessions: async (): Promise<SessionRow[]> => {
        const list = await sessions.list();
        return list.map((s) => ({
          id: s.id,
          name: s.name,
          project: s.projectPath ?? '',
          alive: (registry?.get(s.id)?.state ?? 'stopped') !== 'stopped',
          tileCount: s.agentCount,
          updatedAt: s.updatedAt,
        }));
      },
      listTiles: async (sessionId: string): Promise<TileRow[]> => {
        const session = await sessions.load(sessionId);
        const rt = registry?.get(sessionId) ?? null;
        const infra = sessionInfra.get(sessionId) ?? null;
        const now = Date.now();
        return session.tiles.map((t) => {
          const tileId = rt?.agentToTile.get(t.agentId) ?? null;
          const summary = tileId && infra ? infra.recorder.summary(tileId) : { lines: 0, lastAt: 0 };
          return {
            id: t.agentId,
            name: t.agentId,
            kind: agentKinds.get(t.agentId) ?? 'agent',
            cwd: t.cwd,
            lines: summary.lines,
            lastActiveAgoSec: summary.lastAt > 0 ? Math.max(0, Math.floor((now - summary.lastAt) / 1000)) : 0,
          };
        });
      },
      liveTileOf: async (sessionId: string, agentId: string): Promise<string | null> => {
        const rt = registry?.get(sessionId) ?? null;
        return rt?.agentToTile.get(agentId) ?? null;
      },
      readScrollback: async (agentId: string, tail?: number): Promise<string> =>
        readScrollback(agentId, typeof tail === 'number' && tail > 0 ? Math.min(tail, 2000) : 500),
      snapshot: async (agentId: string): Promise<string> => readScrollback(agentId, 200),
      sendTask: async ({ agentId, kind, body }) => {
        const rt = runtimeOfAgent(agentId);
        if (!rt) return { ok: false, error: `unknown agent ${agentId}` };
        const id = messageId();
        const delivered = await rt.router.sendFromOrchestrator({
          id,
          from: ORCHESTRATOR_ID,
          to: agentId,
          kind,
          body,
          at: Date.now(),
        });
        return delivered ? { ok: true, messageId: id } : { ok: false, error: 'message rejected by the mailbox' };
      },
      listMessages: async (limit?: number): Promise<MessageRow[]> => {
        const rt = activeRuntime() ?? null;
        // read + parse one session's messages.jsonl
        const readSessionMessages = async (sessionId: string): Promise<MessageRow[]> => {
          try {
            const raw = await readFile(join(sessionsRoot, sessionId, 'messages.jsonl'), 'utf8');
            const out: MessageRow[] = [];
            for (const line of raw.split('\n')) {
              if (line.trim().length === 0) continue;
              try {
                const m = JSON.parse(line) as { kind?: string; from?: string; to?: string; body?: string; at?: number };
                if (typeof m.kind !== 'string' || typeof m.body !== 'string') continue;
                out.push({ kind: m.kind as MessageRow['kind'], from: m.from ?? '', to: m.to ?? '', body: m.body, ts: m.at ?? 0 });
              } catch {
                // a corrupt line must not hide the rest of the history
              }
            }
            return out.sort((a, b) => b.ts - a.ts);
          } catch {
            return [];
          }
        };
        const rows = (rt
          ? await rt.router.listMessages(rt.session.id)
          : await (async () => {
              const list = await sessions.list();
              if (list.length === 0) return [];
              // no active runtime: merge EVERY session's history so the phone's
              // global feed is not silently one arbitrary (most-recently-touched)
              // session's messages
              const allRows: MessageRow[] = [];
              for (const session of list) {
                allRows.push(...(await readSessionMessages(session.id)));
              }
              return allRows.sort((a, b) => b.ts - a.ts);
            })()) as MessageRow[];
        return rows.slice(0, typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50).map((m) => ({
          kind: m.kind,
          from: m.from,
          to: m.to,
          body: m.body,
          ts: m.ts,
        }));
      },
      spawnAgent: async ({ cwd, kind, name: _name }) => {
        let rt = activeRuntime();
        if (!rt) {
          const list = await sessions.list();
          if (list.length === 0) return { ok: false, error: 'no session available' };
          const session = await sessions.load(list[0]!.id);
          rt = registry!.open(session.id, session);
          refreshMenu();
        }
        const res = await spawnAgentInSession(rt, kind === 'shell' ? undefined : kind, cwd ?? judgeCwdFor(rt.session));
        return res.ok ? { ok: true, agentId: res.agentId } : { ok: false, error: res.error };
      },
    });

    const buildRemoteStatus = async (): Promise<RemoteStatus> => {
      const state = await remoteStore.get();
      const code = remote?.pairingCode ?? null;
      const devices = await remote?.devices() ?? [];
      return {
        enabled: state.enabled,
        port: state.port,
        listening: remote?.listening ?? false,
        error: remoteError,
        fingerprint: remote?.fingerprint256 ?? null,
        lanIps: lanIps(),
        pairingCode: code?.code ?? null,
        pairingCodeExpiresAt: code?.expiresAt ?? null,
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          connected: d.connected,
          createdAt: d.createdAt,
          lastSeen: d.lastSeen,
        })),
      };
    };

    const pushRemoteStatus = (): void => {
      void buildRemoteStatus().then((status) => mainWindow?.webContents.send(IPC.remoteStatus, status));
    };

    const enableRemote = async (): Promise<void> => {
      const state = await remoteStore.get();
      remote?.stop();
      remote = new RemoteBridge({
        port: state.port,
        backend: makeRemoteBackend(),
        store: remoteStore,
        certDir: join(app.getPath('userData'), 'remote'),
        logger: (line) => console.log(line),
        onStatusChange: pushRemoteStatus,
      });
      try {
        await remote.start();
        remoteError = null;
      } catch (err) {
        remoteError = (err as Error).message;
        throw err;
      }
      pushRemoteStatus();
    };

    const disableRemote = (): void => {
      remote?.stop();
      remote = null;
      pushRemoteStatus();
    };

    ipcMain.handle(IPC.remoteGetState, async (): Promise<RemoteStatus> => {
      // boot-time catch-up: honors a persisted/environment enable
      const state = await remoteStore.get();
      if (state.enabled && !remote) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge start failed:', err);
          pushRemoteStatus();
        }
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteSetEnabled, async (_e, enabled: unknown): Promise<RemoteStatus> => {
      const on = enabled === true || enabled === 'true';
      await remoteStore.setEnabled(on);
      if (on) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge start failed:', err);
        }
      } else {
        disableRemote();
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteSetPort, async (_e, port: unknown): Promise<RemoteStatus> => {
      // only a sane port is worth persisting; garbage must not reset the
      // user's configured port to the default
      const numeric = typeof port === 'number' ? port : Number(port);
      if (!Number.isInteger(numeric) || numeric <= 0 || numeric >= 65536) return buildRemoteStatus();
      await remoteStore.setPort(numeric);
      if (remote?.listening) {
        try {
          await enableRemote();
        } catch (err) {
          console.error('remote bridge restart failed:', err);
        }
      }
      return buildRemoteStatus();
    });
    ipcMain.handle(IPC.remoteRevokeDevice, async (_e, deviceId: string): Promise<boolean> => {
      const revoked = await remoteStore.revokeDevice(deviceId);
      if (revoked) {
        remote?.revokeDevice(deviceId);
        pushRemoteStatus();
      }
      return revoked;
    });
    // keep the Remote tab's last-seen times fresh
    const remoteHeartbeat = setInterval(() => {
      if (remote?.listening) pushRemoteStatus();
    }, 30_000);
    remoteHeartbeat.unref();

    app.on('will-quit', () => {
      registry?.killAll();
      remote?.stop();
      remote = null;
    });

    // boot-time bridge start: persisted enable state (or FRAKTOLE_REMOTE_ENABLE)
    if ((await remoteStore.get()).enabled || process.env.FRAKTOLE_REMOTE_ENABLE === '1') {
      try {
        await enableRemote();
      } catch (err) {
        console.error('remote bridge start failed:', err);
        pushRemoteStatus();
      }
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
