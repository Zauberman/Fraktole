import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionView, type ActiveInfo } from './components/SessionView.js';
import { Explorer } from './components/Explorer.js';
import { FileEditor } from './components/FileEditor.js';
import { useFileEditor } from './file-state.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { QuickOpen } from './components/QuickOpen.js';
import { SessionNameDialog } from './components/SessionNameDialog.js';
import { Divider } from './components/Divider.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar, type AppTab } from './components/TopBar.js';
import { TestTab } from './components/TestTab.js';
import { RemoteTab } from './components/RemoteTab.js';
import { ThemeProvider } from './theme-context.js';
import { applyTheme, DEFAULT_THEME, THEME_IDS, type ThemeId } from './themes.js';
import { bridge, type Project, type SessionSummary } from './ipc.js';
import type { SessionState } from './session-state.js';
import { listIds } from './window-tree.js';
import './theme.css';

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
/goal <text>   arm the watchdog goal (bare /goal clears it)
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
  const editor = useFileEditor();

  const [info, setInfo] = useState<string>('');
  const [bootLeaving, setBootLeaving] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME);
  const [sidePct, setSidePct] = useState({ left: 10, right: 40 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('');
  const [sessionDialog, setSessionDialog] = useState<{ mode: 'new' } | { mode: 'rename' | 'save-as'; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Active project root for the quick-open palette (Ctrl+P). */
  const [quickOpenRoot, setQuickOpenRoot] = useState<string | null>(null);
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

  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

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
      // quick-open palette: Ctrl+P (also works with Shift) anywhere, but
      // never while typing in an input/textarea/editor
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (key === 'p')) {
        const target = e.target;
        if (target instanceof HTMLElement) {
          if (target.closest('input, textarea, select') !== null || target.isContentEditable) return;
        }
        const root = activeInfo.projectPath ?? null;
        if (root) {
          e.preventDefault();
          e.stopPropagation();
          setQuickOpenRoot(root);
        }
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
    return () => {
      unsubTile();
      unsubTheme();
      unsubSpawn();
      unsubSession();
      unsubTest();
      unsubHelp();
    };
  }, [openTileDialog, setTheme, sessions, activate, deleteSession, stopSession, startSession]);

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
            />
          ))}
          <div className={`app-main-tab${tab === 'editor' ? '' : ' app-main-tab-hidden'}`}>
            <div className="pane pane-workspace">
              <FileEditor
                projectPath={activeInfo.projectPath}
                files={editor.files}
                activePath={editor.activePath}
                onActivate={editor.activate}
                onClose={editor.closeFile}
                onUpdate={editor.updateContent}
                onSave={editor.saveFile}
              />
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
      {quickOpenRoot && (
        <QuickOpen
          root={quickOpenRoot}
          onOpen={(path) => {
            setQuickOpenRoot(null);
            void editor.openFile(path);
            setTab('editor');
          }}
          onCancel={() => setQuickOpenRoot(null)}
        />
      )}
      {notice && (
        <div className="app-notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {help && (
        <div className="dialog-backdrop" onMouseDown={() => setHelp(null)}>
          <section className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dialog-title">reviewer commands</div>
            <pre className="help-pre">{help}</pre>
            <div className="reviewer-config-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setHelp(null)}>
                close
              </button>
            </div>
          </section>
        </div>
      )}
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
