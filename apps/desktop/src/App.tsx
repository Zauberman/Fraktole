import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionView, type ActiveInfo } from './components/SessionView.js';
import { Explorer } from './components/Explorer.js';
import { FileEditor } from './components/FileEditor.js';
import { useFileEditor } from './file-state.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { Palette, type PaletteCommand } from './components/Palette.js';
import { SearchPanel } from './components/SearchPanel.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { SessionNameDialog } from './components/SessionNameDialog.js';
import { Divider } from './components/Divider.js';
import { StatusBar } from './components/StatusBar.js';
import { HelpDialog } from './components/HelpDialog.js';
import { useGitStatus } from './components/explorer/useGitStatus.js';
import { TopBar, type AppTab } from './components/TopBar.js';
import { TestTab } from './components/TestTab.js';
import { RemoteTab } from './components/RemoteTab.js';
import { ThemeProvider } from './theme-context.js';
import { applyTheme, DEFAULT_THEME, THEME_IDS, THEMES, type ThemeId } from './themes.js';
import { bridge, type Project, type SessionSummary, type SettingsSection } from './ipc.js';
import type { SessionState } from './session-state.js';
import { listIds } from './window-tree.js';
import { AUTONOMY_NAMES } from './shared/autonomy.js';
import './styles/index.css';

function BootOverlay({ leaving }: { leaving: boolean }): React.JSX.Element {
  return (
    <div className={`boot-overlay${leaving ? ' boot-leave' : ''}`}>
      <div className="boot-wordmark">
        <span className="boot-wordmark-inner">
          FRAKTOLE<span className="boot-dot">.</span>
        </span>
      </div>
    </div>
  );
}

/** Shown via Help → Reviewer commands… — the Reviewer prompt-box commands. */
const REVIEWER_COMMANDS = `Reviewer commands — type these in the Reviewer prompt box:
/goal <text>   arm the loop carrier goal (bare /goal clears it)
/compact       force a context compaction now
/summarize     ask the model for a session recap, then compact the context
/kill <id>     kill the running agent tile <id>`;

export function App(): React.JSX.Element {
  // session + tab orchestration
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tab, setTab] = useState<AppTab>('node');
  const sessionStates = useRef<Map<string, SessionState>>(new Map());
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const tabRef = useRef<AppTab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  const [activeInfo, setActiveInfo] = useState<ActiveInfo>({
    tileCount: 0,
    focusedCwd: null,
    sessionName: null,
    state: 'running',
    projectPath: null,
  } satisfies ActiveInfo);

  const [notice, setNotice] = useState<string | null>(null);
  const editor = useFileEditor({ onNotice: setNotice });
  const git = useGitStatus(activeInfo.projectPath);
  const [info, setInfo] = useState<string>('');
  const [bootLeaving, setBootLeaving] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME);
  const [sidePct, setSidePct] = useState({ left: 10, right: 40 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('');
  const [sessionDialog, setSessionDialog] = useState<{ mode: 'new' } | { mode: 'rename' | 'save-as'; value: string } | null>(null);
  /** Open command palette with its initial mode (Ctrl+P files, Ctrl+Shift+P commands). */
  const [palette, setPalette] = useState<{ mode: 'files' | 'commands' } | null>(null);
  /** The in-app Settings Center (null = closed; otherwise the active section). */
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  /** Project-wide search panel (editor tab, Ctrl+Shift+F). */
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState<string | null>(null);
  /** URL pushed by the reviewer's open_test_page; forwarded to the TestTab. */
  const [pendingTestUrl, setPendingTestUrl] = useState<string | null>(null);
  const defaultCwd = useRef('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);

  // the right pane's percentage is of the whole body; its flex parent is the
  // main area (body minus the left pane and one divider) — convert so a 40%
  // right pane really is 40% of the body
  const divPct = bodyWidth > 0 ? (6 / bodyWidth) * 100 : 0.5;
  const rightOfMain = (sidePct.right / Math.max(1, 100 - sidePct.left - divPct)) * 100;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => setBodyWidth(body.getBoundingClientRect().width));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const dragDivider = useCallback((which: 'left' | 'right', clientX: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSidePct((s) => {
      if (which === 'left') return { ...s, left: Math.min(25, Math.max(8, pct)) };
      const right = Math.min(60, Math.max(25, ((rect.right - clientX) / rect.width) * 100));
      return { ...s, right };
    });
  }, []);

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      setProjects(await bridge.listProjects());
    } catch (err) {
      console.error('listProjects failed:', err);
    }
  }, []);

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      setSessions(await bridge.listSessions());
    } catch {
      // session list unavailable — the switcher stays empty
    }
  }, []);

  const activate = useCallback((sid: string): void => {
    setActiveSessionId(sid);
    setOpened((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  }, []);

  useEffect(() => {
    void refreshProjects();
    void bridge
      .getAppInfo()
      .then((i) => {
        defaultCwd.current = i.home;
        setDialogDefault(i.home);
        setInfo(`${i.version} · ${i.shell}`);
      })
      .catch((err) => setInfo(`unavailable: ${String(err)}`));
    void bridge
      .getSettings()
      .then((s) => {
        const id = s.theme as ThemeId;
        const valid = THEME_IDS.includes(id);
        setThemeIdState(valid ? id : DEFAULT_THEME);
        applyTheme(valid ? id : DEFAULT_THEME);
      })
      .catch(() => applyTheme(DEFAULT_THEME));
    // boot: resume the most recent session, or start one fresh
    void (async () => {
      const list = await bridge.listSessions().catch(() => [] as SessionSummary[]);
      if (list.length > 0) {
        activate(list[0]!.id);
      } else {
        const created = await bridge.newSession('Session 1').catch(() => null);
        if (created) activate(created.session.id);
      }
      await refreshSessions();
    })();
  }, [activate, refreshSessions, refreshProjects]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeIdState(id);
    applyTheme(id);
    void bridge.setSettings({ theme: id }).catch(() => undefined);
  }, []);

  const openSettings = useCallback((section: SettingsSection = 'general'): void => {
    setSettingsOpen(section);
  }, []);

  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // persisted per-project editor tabs re-open when the active project changes
  // (restoreTabs itself is a per-project no-op, so re-runs are harmless)
  useEffect(() => {
    if (activeInfo.projectPath) void editor.restoreTabs(activeInfo.projectPath);
  }, [activeInfo.projectPath]);

  const dialogOpenRef = useRef(false);
  useEffect(() => {
    dialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const openTileDialog = useCallback(() => {
    if (dialogOpenRef.current) return;
    const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
    const f = ws?.focusedIdRef.current ?? null;
    const fallback = f
      ? (ws?.tilesRef.current.get(f)?.cwd ?? defaultCwd.current)
      : (projectsRef.current[0]?.path ?? defaultCwd.current);
    setDialogDefault(fallback);
    setDialogOpen(true);
  }, []);

  const openProject = useCallback(
    async (path: string): Promise<void> => {
      try {
        const opened = await bridge.openProject(path);
        if (opened.session.id !== activeSessionIdRef.current) {
          activate(opened.session.id);
        }
        await refreshSessions();
      } catch {
        // project/session load failure — keep the current view
      }
    },
    [activate, refreshSessions],
  );

  const newSession = useCallback(
    async (name: string): Promise<void> => {
      try {
        const opened = await bridge.newSession(name);
        activate(opened.session.id);
        await refreshSessions();
      } catch {
        // creation failure is surfaced by the panel form caller
      }
    },
    [activate, refreshSessions],
  );

  const stopSession = useCallback(async (sid: string): Promise<void> => {
    await bridge.stopSession(sid);
    await refreshSessions();
  }, [refreshSessions]);

  const startSession = useCallback(async (sid: string): Promise<void> => {
    await bridge.startSession(sid);
    // the view's PTYs were killed by the stop; re-activate it so its tiles
    // rebuild instead of leaving a permanently empty workspace
    void sessionStates.current.get(sid)?.reactivate();
    await refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(    async (sid: string): Promise<void> => {
      await bridge.deleteSession(sid);
      setOpened((prev) => prev.filter((s) => s !== sid));
      if (sid === activeSessionIdRef.current) {
        const list = await bridge.listSessions().catch(() => [] as SessionSummary[]);
        if (list.length > 0) {
          activate(list[0]!.id);
        } else {
          const created = await bridge.newSession('Session 1').catch(() => null);
          if (created) activate(created.session.id);
        }
      }
      await refreshSessions();
    },
    [activate, refreshSessions],
  );

  const confirmSessionDialog = useCallback(
    (name: string): void => {
      if (!sessionDialog) return;
      const activeId = activeSessionIdRef.current;
      if (sessionDialog.mode === 'new') {
        void newSession(name);
      } else if (activeId) {
        const ws = sessionStates.current.get(activeId) ?? null;
        if (sessionDialog.mode === 'rename') {
          void ws?.renameSession(name);
        } else {
          void bridge.saveSessionAs(activeId, name).then(() => refreshSessions()).catch(() => undefined);
        }
      }
      setSessionDialog(null);
    },
    [sessionDialog, newSession, refreshSessions],
  );

  const registerState = useCallback((sid: string, state: SessionState): (() => void) => {
    sessionStates.current.set(sid, state);
    return () => {
      sessionStates.current.delete(sid);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (dialogOpenRef.current) return;
      const key = e.key.toLowerCase();
      // alt+1/2/3 switch base tabs
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (key === '1') {
          e.preventDefault();
          setTab('editor');
          return;
        }
        if (key === '2') {
          e.preventDefault();
          setTab('node');
          return;
        }
        if (key === '3') {
          e.preventDefault();
          setTab('test');
          return;
        }
        if (key === '4') {
          e.preventDefault();
          setTab('remote');
          return;
        }
      }
      // command palette: Ctrl+P files, Ctrl+Shift+P commands — never while
      // typing in an input/textarea/editor
      if (e.ctrlKey && !e.altKey && !e.metaKey && (key === 'p' || key === ',')) {
        const target = e.target;
        if (target instanceof HTMLElement) {
          if (target.closest('input, textarea, select') !== null || target.isContentEditable) return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (key === ',') openSettings('general');
        else setPalette({ mode: e.shiftKey ? 'commands' : 'files' });
        return;
      }
      // project search lives on the editor tab (terminal has its own search)
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'f' && tabRef.current === 'editor') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        return;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      // the node-tile shortcuts must not hijack typing: they only apply on
      // the node tab, and never while an input/textarea/editor has focus —
      // the terminal itself is exempt, its hidden textarea is the tile's
      // own input
      if (tabRef.current !== 'node') return;
      const target = e.target;
      if (target instanceof HTMLElement && target.closest('.terminal-host') === null) {
        if (target.closest('input, textarea, select') !== null || target.isContentEditable) return;
      }
      const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
      if (!ws) return;
      let handled = true;
      if (key === 't') {
        openTileDialog();
      } else if (key === 'o') {
        void bridge.pickFolder().then((p) => {
          if (p) void bridge.addProject(p).then(() => refreshProjects()).catch(() => undefined);
        });
      } else if (key === 'w') {
        if (ws.reviewerFocusedRef.current) {
          // the reviewer column is focused — nothing to close
        } else if (ws.focusedIdRef.current) {
          ws.closeTile(ws.focusedIdRef.current);
        }
      } else if (key === 'enter') {
        if (!ws.reviewerFocusedRef.current) {
          const f = ws.focusedIdRef.current;
          if (f) ws.toggleZoom(f);
        }
      } else if (key === 'arrowleft' || key === 'arrowup') {
        ws.moveFocus('prev');
      } else if (key === 'arrowright' || key === 'arrowdown') {
        ws.moveFocus('next');
      } else if (key === '0') {
        ws.setReviewerFocused(true);
      } else if (/^[1-9]$/.test(key)) {
        ws.setReviewerFocused(false);
        const ids = listIds(ws.treeRef.current);
        const target = ids[Number(key) - 1];
        if (target) ws.setFocusedId(target);
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [openTileDialog, refreshProjects]);

  useEffect(() => {
    const unsubTile = bridge.onMenuNewTile(openTileDialog);
    const unsubTheme = bridge.onMenuTheme((id) => {
      if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
    });
    const unsubSpawn = bridge.onReviewerSpawnRequest((ev) => {
      const ws = sessionStates.current.get(ev.sessionId) ?? null;
      if (!ws) {
        void bridge.reviewerSpawnResult(ev.sessionId, ev.requestId, { tileId: null, agentId: ev.agentId });
        return;
      }
      const tileId = ws.addTile(ev.cwd, ev.agentId, ev.command);
      void bridge.reviewerSpawnResult(ev.sessionId, ev.requestId, { tileId, agentId: ev.agentId });
    });
    // the native Session menu forwards its actions here (the orchestrator
    // panel that used to own them is gone)
    const unsubSession = bridge.onMenuSession((action) => {
      const activeId = activeSessionIdRef.current;
      const activeName = activeId ? (sessionStates.current.get(activeId)?.sessionRef?.current?.name ?? null) : null;
      if (action.action === 'new') {
        setSessionDialog({ mode: 'new' });
      } else if (action.action === 'rename') {
        setSessionDialog({ mode: 'rename', value: activeName ?? 'Session' });
      } else if (action.action === 'save-as') {
        setSessionDialog({ mode: 'save-as', value: activeName ?? 'Session' });
      } else if (action.action === 'open' && action.id) {
        activate(action.id);
      } else if (action.action === 'delete' && action.id) {
        const target = sessions.find((s) => s.id === action.id);
        if (target && window.confirm(`Delete session "${target.name}"?`)) {
          void deleteSession(action.id);
        }
      } else if (action.action === 'stop' && action.id) {
        void stopSession(action.id);
      } else if (action.action === 'start' && action.id) {
        void startSession(action.id);
      } else if (action.action === 'export-bundle') {
        if (!activeId) {
          setNotice('no active session to export');
          return;
        }
        void bridge.exportSessionBundle(activeId).then((res) => {
          if (res.ok) setNotice(`session exported to ${res.path}`);
          else if (!res.canceled) setNotice(res.error);
        });      } else if (action.action === 'import-bundle') {
        void bridge.importSessionBundle().then((res) => {
          if (res.ok && res.session) {
            activate(res.session.id);
            void refreshSessions();
            setNotice(`session "${res.session.name}" imported`);
          } else if (!res.ok && !res.canceled) {
            setNotice(res.error);
          }
        });
      }
    });
    // the reviewer's open_test_page: switch to the Test tab and load
    const unsubTest = bridge.onTestOpen((sessionId: string, ev: { url: string }) => {
      if (sessionId !== activeSessionIdRef.current) activate(sessionId);
      setTab('test');
      setPendingTestUrl(ev.url);
    });
    // the native Help menu forwards topics here
    const unsubHelp = bridge.onMenuHelp((topic) => {
      if (topic === 'reviewer-commands') setHelp(REVIEWER_COMMANDS);
    });
    // the native Settings menu jumps straight to a section
    const unsubSettings = bridge.onMenuSettings((action) => openSettings(action.section ?? 'general'));
    return () => {
      unsubTile();
      unsubTheme();
      unsubSpawn();
      unsubSession();
      unsubTest();
      unsubHelp();
      unsubSettings();
    };
  }, [openTileDialog, setTheme, sessions, activate, deleteSession, stopSession, startSession, openSettings]);

  /** Every palette command: tabs, settings sections, themes, session and
   *  reviewer actions. Labels mirror the shortcut registry where one exists. */
  const paletteCommands: PaletteCommand[] = [
    { id: 'tab.editor', label: 'File Editor tab', keys: 'Alt+1', section: 'tabs', run: () => setTab('editor') },
    { id: 'tab.node', label: 'Node tab', keys: 'Alt+2', section: 'tabs', run: () => setTab('node') },
    { id: 'tab.test', label: 'Test tab', keys: 'Alt+3', section: 'tabs', run: () => setTab('test') },
    { id: 'tab.remote', label: 'Remote tab', keys: 'Alt+4', section: 'tabs', run: () => setTab('remote') },
    { id: 'settings.open', label: 'Open settings', keys: 'Ctrl+,', section: 'settings', run: () => openSettings('general') },
    { id: 'settings.model', label: 'Settings: model', section: 'settings', run: () => openSettings('model') },
    { id: 'settings.sampling', label: 'Settings: sampling & context', section: 'settings', run: () => openSettings('sampling') },
    { id: 'settings.agents', label: 'Settings: agents & launchers', section: 'settings', run: () => openSettings('agents') },
    { id: 'settings.compose', label: 'Settings: auto compose', section: 'settings', run: () => openSettings('compose') },
    { id: 'settings.editor', label: 'Settings: editor', section: 'settings', run: () => openSettings('editor') },
    { id: 'settings.shortcuts', label: 'Settings: shortcuts', section: 'settings', run: () => openSettings('shortcuts') },
    { id: 'settings.usage', label: 'Settings: usage', section: 'settings', run: () => openSettings('usage') },
    { id: 'settings.advanced', label: 'Settings: advanced', section: 'settings', run: () => openSettings('advanced') },
    ...THEMES.map((t): PaletteCommand => ({
      id: `theme.${t.id}`,
      label: `Theme: ${t.name}`,
      section: 'themes',
      run: () => {
        if (THEME_IDS.includes(t.id as ThemeId)) setTheme(t.id as ThemeId);
      },
    })),
    { id: 'tile.new', label: 'New tile', keys: 'Ctrl+Shift+T', section: 'session', run: openTileDialog },
    {
      id: 'session.new',
      label: 'New session',
      section: 'session',
      run: () => setSessionDialog({ mode: 'new' }),
    },
    {
      id: 'session.rename',
      label: 'Rename session',
      section: 'session',
      run: () => setSessionDialog({ mode: 'rename', value: activeSessionId ? (sessionStates.current.get(activeSessionId)?.sessionRef?.current?.name ?? 'Session') : 'Session' }),
    },
    {
      id: 'session.save-as',
      label: 'Save session as…',
      section: 'session',
      run: () => setSessionDialog({ mode: 'save-as', value: activeSessionId ? (sessionStates.current.get(activeSessionId)?.sessionRef?.current?.name ?? 'Session') : 'Session' }),
    },
    {
      id: 'session.export',
      label: 'Export session bundle',
      section: 'session',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (!activeId) {
          setNotice('no active session to export');
          return;
        }
        void bridge.exportSessionBundle(activeId).then((res) => {
          if (res.ok) setNotice(`session exported to ${res.path}`);
          else if (!res.canceled) setNotice(res.error);
        });
      },
    },
    {
      id: 'session.import',
      label: 'Import session bundle',
      section: 'session',
      run: () => {
        void bridge.importSessionBundle().then((res) => {
          if (res.ok && res.session) {
            activate(res.session.id);
            void refreshSessions();
            setNotice(`session "${res.session.name}" imported`);
          } else if (!res.ok && !res.canceled) {
            setNotice(res.error);
          }
        });
      },
    },
    {
      id: 'reviewer.compact',
      label: 'Reviewer: compact context now',
      section: AUTONOMY_NAMES.custom === 'Custom' ? 'reviewer' : 'reviewer',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (activeId) void bridge.compactReviewer(activeId);
      },
    },
    {
      id: 'reviewer.summarize',
      label: 'Reviewer: summarize session',
      section: 'reviewer',
      run: () => {
        const activeId = activeSessionIdRef.current;
        if (activeId) void bridge.summarizeReviewer(activeId).then(() => undefined);
      },
    },
  ];

  useEffect(() => {
    const t1 = window.setTimeout(() => setBootLeaving(true), 500);
    const t2 = window.setTimeout(() => setBootGone(true), 650);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  return (
    <ThemeProvider themeId={themeId} setTheme={setTheme}>
      <div className="app-shell">
        <TopBar tab={tab} onTabChange={setTab} />
        <div ref={bodyRef} className="app-body">
        <section className="pane pane-side" style={{ width: `${sidePct.left}%` }}>
          <Explorer
            projects={projects}
            activePath={activeInfo.focusedCwd}
            activeProjectPath={activeInfo.projectPath}
            onOpenProject={(path) => void openProject(path)}
            onOpenFile={(path) => {
              void editor.openFile(path);
              setTab('editor');
            }}
            onRemoveProject={(path) => {
              void bridge.removeProject(path).then(() => refreshProjects()).catch(() => undefined);
            }}
            onAddFolder={() => {
              void bridge.pickFolder().then((p) => {
                if (p) void bridge.addProject(p).then(() => refreshProjects()).catch(() => undefined);
              });
            }}
          />
        </section>
        <Divider onDrag={(x) => dragDivider('left', x)} />
        <main className="app-main">
          {opened.map((sid) => (
            <SessionView
              key={sid}
              sessionId={sid}
              active={sid === activeSessionId}
              tab={tab}
              sideRightPct={rightOfMain}
              onDragRight={(x) => dragDivider('right', x)}
              onActivate={activate}
              registerState={registerState}
              onActiveInfo={setActiveInfo}
              onOpenSettings={openSettings}
            />
          ))}
          <div className={`app-main-tab${tab === 'editor' ? '' : ' app-main-tab-hidden'}`}>
            <div className="editor-tab-stack">
              <div className="pane pane-workspace">
                <FileEditor
                  projectPath={activeInfo.projectPath}
                  files={editor.files}
                  activePath={editor.activePath}
                  reveal={editor.reveal}
                  onActivate={editor.activate}
                  onClose={editor.closeFile}
                  onUpdate={editor.updateContent}
                  onSave={editor.saveFile}
                  onSaveAll={() => void editor.saveAll()}
                  onReload={(p) => editor.reloadFile(p)}
                  onDismissStale={editor.dismissStale}
                />
              </div>
              {searchOpen && activeInfo.projectPath && (
                <SearchPanel
                  root={activeInfo.projectPath}
                  onClose={() => setSearchOpen(false)}
                  onOpen={(path, line) => {
                    void editor.openFile(path).then(() => editor.revealLine(path, line));
                  }}
                />
              )}
            </div>
          </div>
          <div className={`app-main-tab${tab === 'test' ? '' : ' app-main-tab-hidden'}`}>
            <div className="pane pane-workspace">
              <TestTab
                sessionId={activeSessionId ?? ''}
                pendingUrl={pendingTestUrl}
                onPendingUrlConsumed={() => setPendingTestUrl(null)}
                active={tab === 'test'}
              />
            </div>
          </div>
          <div className={`app-main-tab${tab === 'remote' ? '' : ' app-main-tab-hidden'}`}>
            <RemoteTab />
          </div>
        </main>
      </div>
      <StatusBar
        sessionName={activeInfo.sessionName}
        sessionState={activeInfo.state}
        tileCount={activeInfo.tileCount}
        focusedCwd={activeInfo.focusedCwd}
        info={info}
        branch={git?.branch ?? null}
        dirtyCount={editor.files.filter((f) => f.dirty).length}
        onOpenShortcuts={() => openSettings('shortcuts')}
      />
      {dialogOpen && (
        <NewTileDialog
          projects={projects}
          defaultPath={dialogDefault}
          onConfirm={(path) => {
            setDialogOpen(false);
            const ws = sessionStates.current.get(activeSessionIdRef.current ?? '');
            ws?.addTile(path);
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
      {sessionDialog && (
        <SessionNameDialog
          title={sessionDialog.mode === 'new' ? 'new session' : sessionDialog.mode === 'rename' ? 'rename session' : 'save session as'}
          initial={sessionDialog.mode === 'new' ? '' : sessionDialog.value}
          confirmLabel={sessionDialog.mode === 'new' ? 'create' : sessionDialog.mode === 'rename' ? 'rename' : 'save'}
          onConfirm={confirmSessionDialog}
          onCancel={() => setSessionDialog(null)}
        />
      )}
      {palette && (
        <Palette
          root={activeInfo.projectPath}
          initialMode={palette.mode}
          commands={paletteCommands}
          onOpenFile={(path) => {
            setPalette(null);
            void editor.openFile(path);
            setTab('editor');
          }}
          onClose={() => setPalette(null)}
        />
      )}
      {settingsOpen && (
        <SettingsView
          section={settingsOpen}
          onSection={setSettingsOpen}
          onClose={() => setSettingsOpen(null)}
          onTheme={(id) => {
            if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
          }}
          themeId={themeId}
          sessionId={activeSessionId}
          onNotice={setNotice}
        />
      )}
      {notice && (
        <div className="app-notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {help && <HelpDialog body={help} onClose={() => setHelp(null)} />}
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
