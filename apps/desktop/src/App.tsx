import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Workspace } from './components/Workspace.js';
import { Explorer } from './components/Explorer.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { Divider } from './components/Divider.js';
import { OrchestratorPanel, type JudgeStatus } from './components/OrchestratorPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { ViewMenu } from './components/ViewMenu.js';
import { ThemeProvider } from './theme-context.js';
import { applyTheme, DEFAULT_THEME, THEME_IDS, type ThemeId } from './themes.js';
import { bridge, type Project, type SendMessageArgs, type SessionSnapshot } from './ipc.js';
import { useSessionState } from './session-state.js';
import { useMessages } from './messages.js';
import { useSnapshots } from './snapshots.js';
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
  const ws = useSessionState();
  const { messages, send } = useMessages(ws.session?.id ?? null);
  const snapshots = useSnapshots();
  const [judgeStatus, setJudgeStatus] = useState<JudgeStatus>('offline');

  const [info, setInfo] = useState<string>('');
  const [bootLeaving, setBootLeaving] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME);
  const [viewOpen, setViewOpen] = useState(false);
  const [sidePct, setSidePct] = useState({ left: 20, right: 20 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('/home/walid');
  const defaultCwd = useRef('/home/walid');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const dragDivider = useCallback((which: 'left' | 'right', clientX: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSidePct((s) => {
      if (which === 'left') return { ...s, left: Math.min(32, Math.max(12, pct)) };
      const right = Math.min(32, Math.max(12, ((rect.right - clientX) / rect.width) * 100));
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
  }, [refreshProjects]);

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
    const f = ws.focusedIdRef.current;
    const fallback = f
      ? (ws.tilesRef.current.get(f)?.cwd ?? defaultCwd.current)
      : (projectsRef.current[0]?.path ?? defaultCwd.current);
    setDialogDefault(fallback);
    setDialogOpen(true);
  }, [ws.focusedIdRef, ws.tilesRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      if (dialogOpenRef.current) return;
      const key = e.key.toLowerCase();
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
  }, [openTileDialog, ws.closeTile, ws.moveFocus, ws.setFocusedId, ws.toggleZoom, ws.treeRef, ws.focusedIdRef, refreshProjects]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    for (const [id] of ws.tiles) {
      unsubs.push(
        bridge.onTileExit(id, () => {
          ws.closeTile(id);
        }),
      );
    }
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [ws.tiles, ws.closeTile]);

  useEffect(() => {
    const unsubTile = bridge.onMenuNewTile(openTileDialog);
    const unsubTheme = bridge.onMenuTheme((id) => {
      if (THEME_IDS.includes(id as ThemeId)) setTheme(id as ThemeId);
    });
    const unsubJudge = bridge.onJudgeExit(() => setJudgeStatus('exited'));
    return () => {
      unsubTile();
      unsubTheme();
      unsubJudge();
    };
  }, [openTileDialog, setTheme]);

  // when a session opens, main spawns the judge; the panel should reflect it
  useEffect(() => {
    setJudgeStatus('running');
  }, [ws.session?.id]);

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
        <TopBar viewOpen={viewOpen} onViewClick={() => setViewOpen((v) => !v)} />
        {viewOpen && <ViewMenu open={viewOpen} current={themeId} onSelect={setTheme} onClose={() => setViewOpen(false)} />}
        <div ref={bodyRef} className="app-body">
        <section className="pane pane-side" style={{ width: `${sidePct.left}%` }}>
          <Explorer
            projects={projects}
            activePath={ws.focusedId ? (ws.tiles.get(ws.focusedId)?.cwd ?? null) : null}
            onOpenProject={ws.openProject}
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
        <section className="pane pane-workspace">
          <Workspace
            tree={ws.tree}
            zoomedId={ws.zoomedId}
            focusedId={ws.focusedId}
            tiles={ws.tiles}
            onFocus={ws.setFocusedId}
            onClose={ws.closeTile}
            onZoom={ws.toggleZoom}
            onSwap={ws.onSwap}
            onSpawned={ws.registerAgent}
          />
        </section>
        <Divider onDrag={(x) => dragDivider('right', x)} />
        <section className="pane pane-side pane-side-right" style={{ width: `${sidePct.right}%` }}>
          <OrchestratorPanel
            session={ws.session}
            sessions={ws.sessions}
            agents={[...ws.tiles.values()].map((m) => ({ tileId: m.id, agentId: m.agentId, cwd: m.cwd }))}
            messages={messages}
            judgeStatus={judgeStatus}
            onSend={async (args: SendMessageArgs): Promise<boolean> => send(args)}
            onSnapshot={async (agentId: string, text: string): Promise<SessionSnapshot> =>
              snapshots.create(agentId, text)
            }
            onGetSnapshot={(id: string) => snapshots.get(id)}
            onFocusAgent={(agentId: string) => {
              const tileId = ws.tileOf(agentId);
              if (tileId) ws.setFocusedId(tileId);
            }}
            onCloseAgent={(agentId: string) => {
              const tileId = ws.tileOf(agentId);
              if (tileId) ws.closeTile(tileId);
            }}
            onNewSession={(name: string) => void ws.newSession(name)}
            onOpenSession={(id: string) => void ws.openSession(id)}
            onRenameSession={(name: string) => void ws.renameSession(name)}
            onDeleteSession={(id: string) => void ws.deleteSession(id)}
            onRetryJudge={() => {
              void bridge.judgeRestart().then((ok) => setJudgeStatus(ok ? 'running' : 'exited'));
            }}
          />
        </section>
      </div>
      <StatusBar
        sessionName={ws.session?.name ?? null}
        tileCount={ws.tiles.size}
        focusedCwd={ws.focusedId ? (ws.tiles.get(ws.focusedId)?.cwd ?? null) : null}
        info={info}
      />
      {dialogOpen && (
        <NewTileDialog
          projects={projects}
          defaultPath={dialogDefault}
          onConfirm={(path) => {
            setDialogOpen(false);
            ws.addTile(path);
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
