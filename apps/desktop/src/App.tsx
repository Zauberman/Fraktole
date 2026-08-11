import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Workspace, type WorkspaceTileMeta } from './components/Workspace.js';
import { Explorer } from './components/Explorer.js';
import { NewTileDialog } from './components/NewTileDialog.js';
import { Divider } from './components/Divider.js';
import { PlannerPanel } from './components/PlannerPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { ViewMenu } from './components/ViewMenu.js';
import { ThemeProvider } from './theme-context.js';
import { applyTheme, DEFAULT_THEME, THEME_IDS, type ThemeId } from './themes.js';
import { bridge, type Project } from './ipc.js';
import type { SplitDir, TileId, TileNode } from './window-tree.js';
import { insert, listIds, neighbors, remove, swap } from './window-tree.js';
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
  const [info, setInfo] = useState<string>('');
  const [bootLeaving, setBootLeaving] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME);
  const [viewOpen, setViewOpen] = useState(false);
  const [tree, setTree] = useState<TileNode | null>(null);
  const [focusedId, setFocusedId] = useState<TileId | null>(null);
  const [zoomedId, setZoomedId] = useState<TileId | null>(null);
  const [tiles, setTiles] = useState<Map<TileId, WorkspaceTileMeta>>(new Map());
  const nextId = useRef(1);
  const insertDir = useRef<SplitDir>('h');
  const defaultCwd = useRef('/home/walid');
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefault, setDialogDefault] = useState('/home/walid');
  const [sidePct, setSidePct] = useState({ left: 20, right: 20 });
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

  const openTileDialog = useCallback(() => {
    if (dialogOpenRef.current) return;
    const f = focusedIdRef.current;
    const fallback = f ? (tilesRef.current.get(f)?.cwd ?? defaultCwd.current) : (projectsRef.current[0]?.path ?? defaultCwd.current);
    setDialogDefault(fallback);
    setDialogOpen(true);
  }, []);

  const addTile = useCallback((cwd: string): TileId => {
    const id = `tile-${nextId.current}`;
    nextId.current += 1;
    const dir = insertDir.current;
    insertDir.current = dir === 'h' ? 'v' : 'h';
    void bridge.addProject(cwd).then(() => refreshProjects()).catch(() => undefined);
    setTiles((m) => {
      const copy = new Map(m);
      copy.set(id, { id, cwd });
      return copy;
    });
    setTree((t) => {
      const next = insert(t, focusedIdRef.current, id, dir);
      return next;
    });
    setFocusedId(id);
    return id;
  }, [refreshProjects]);

  const openProject = useCallback(
    (path: string): void => {
      const existing = [...tiles.values()].find((t) => t.cwd === path);
      if (existing) {
        setFocusedId(existing.id);
        return;
      }
      addTile(path);
    },
    [tiles, addTile],
  );

  const focusedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const closeTile = useCallback((id: TileId) => {
    const next = remove(treeRef.current, id);
    setTree(next);
    if (focusedIdRef.current === id) {
      setFocusedId(listIds(next).length > 0 ? (listIds(next)[0] ?? null) : null);
    }
    if (zoomedIdRef.current === id) setZoomedId(null);
    setTiles((m) => {
      const copy = new Map(m);
      copy.delete(id);
      return copy;
    });
  }, []);

  const zoomedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    zoomedIdRef.current = zoomedId;
  }, [zoomedId]);

  const moveFocus = useCallback((dir: 'prev' | 'next') => {
    setFocusedId((f) => neighbors(treeRef.current, f ?? '', dir));
  }, []);

  const treeRef = useRef<TileNode | null>(null);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const tilesRef = useRef<Map<TileId, WorkspaceTileMeta>>(new Map());
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const dialogOpenRef = useRef(false);
  useEffect(() => {
    dialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const onSwap = useCallback((a: TileId, b: TileId) => {
    setTree((t) => (t === null ? t : swap(t, a, b)));
  }, []);

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
        if (focusedIdRef.current) closeTile(focusedIdRef.current);
      } else if (key === 'enter') {
        const f = focusedIdRef.current;
        if (f) setZoomedId((z) => (z === f ? null : f));
      } else if (key === 'arrowleft' || key === 'arrowup') {
        moveFocus('prev');
      } else if (key === 'arrowright' || key === 'arrowdown') {
        moveFocus('next');
      } else if (/^[1-9]$/.test(key)) {
        const ids = listIds(treeRef.current);
        const target = ids[Number(key) - 1];
        if (target) setFocusedId(target);
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
  }, [addTile, closeTile, moveFocus, openTileDialog]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    for (const [id] of tiles) {
      unsubs.push(
        bridge.onTileExit(id, () => {
          closeTile(id);
        }),
      );
    }
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [tiles, closeTile]);

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
        <TopBar viewOpen={viewOpen} onViewClick={() => setViewOpen((v) => !v)} />
        {viewOpen && <ViewMenu open={viewOpen} current={themeId} onSelect={setTheme} onClose={() => setViewOpen(false)} />}
        <div ref={bodyRef} className="app-body">
        <section className="pane pane-side" style={{ width: `${sidePct.left}%` }}>
          <Explorer
            projects={projects}
            activePath={focusedId ? (tiles.get(focusedId)?.cwd ?? null) : null}
            onOpenProject={openProject}
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
            tree={tree}
            zoomedId={zoomedId}
            focusedId={focusedId}
            tiles={tiles}
            onFocus={setFocusedId}
            onClose={closeTile}
            onZoom={(id) => setZoomedId((z) => (z === id ? null : id))}
            onSwap={onSwap}
          />
        </section>
        <Divider onDrag={(x) => dragDivider('right', x)} />
        <section className="pane pane-side pane-side-right" style={{ width: `${sidePct.right}%` }}>
          <PlannerPanel />
        </section>
      </div>
      <StatusBar
        tileCount={tiles.size}
        focusedCwd={focusedId ? (tiles.get(focusedId)?.cwd ?? null) : null}
        info={info}
      />
      {dialogOpen && (
        <NewTileDialog
          projects={projects}
          defaultPath={dialogDefault}
          onConfirm={(path) => {
            setDialogOpen(false);
            addTile(path);
          }}
          onCancel={() => setDialogOpen(false)}
        />
      )}
      {!bootGone && <BootOverlay leaving={bootLeaving} />}
      </div>
    </ThemeProvider>
  );
}
