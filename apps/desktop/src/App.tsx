import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionView, type ActiveInfo } from './components/SessionView.js';
import { Explorer } from './components/Explorer.js';
import { FileEditor } from './components/FileEditor.js';
import { useFileEditor } from './file-state.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { Divider } from './components/Divider.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar, type AppTab } from './components/TopBar.js';
import { ViewMenu } from './components/ViewMenu.js';
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
  const [viewOpen, setViewOpen] = useState(false);
  const [sidePct, setSidePct] = useState({ left: 10, right: 40 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('/home/walid');
  const defaultCwd = useRef('/home/walid');
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
        activate(opened.session.id);
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
    await refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(
    async (sid: string): Promise<void> => {
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
          setTab('reviewer');
          return;
        }
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
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
        if (ws.focusedIdRef.current) ws.closeTile(ws.focusedIdRef.current);
      } else if (key === 'enter') {
        const f = ws.focusedIdRef.current;
        if (f) ws.toggleZoom(f);
      } else if (key === 'arrowleft' || key === 'arrowup') {
        ws.moveFocus('prev');
      } else if (key === 'arrowright' || key === 'arrowdown') {
        ws.moveFocus('next');
      } else if (/^[1-9]$/.test(key)) {
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
    return () => {
      unsubTile();
      unsubTheme();
    };
  }, [openTileDialog, setTheme]);

  useEffect(() => {
    const t1 = window.setTimeout(() => setBootLeaving(true), 500);
    const t2 = window.setTimeout(() => setBootGone(true), 650);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  return (
    <ThemeProvider themeId={themeId} setTheme={setTheme}>
      <div className="app-shell">
        <TopBar viewOpen={viewOpen} onViewClick={() => setViewOpen((v) => !v)} tab={tab} onTabChange={setTab} />
        {viewOpen && <ViewMenu open={viewOpen} current={themeId} onSelect={setTheme} onClose={() => setViewOpen(false)} />}
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
              sessions={sessions}
              sideRightPct={rightOfMain}
              onDragRight={(x) => dragDivider('right', x)}
              onActivate={activate}
              onNewSession={(name) => void newSession(name)}
              onDeleteSession={(sid2) => void deleteSession(sid2)}
              onStopSession={(sid2) => void stopSession(sid2)}
              onStartSession={(sid2) => void startSession(sid2)}
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
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
