import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/explorer.css';
import { bridge, type FsEntry, type GitStatus, type Project } from '../ipc.js';
import { Dialog } from './Dialog.js';
import { classifyFile, nameClassFor } from '../file-kinds.js';
import { NameDialog } from './explorer/NameDialog.js';
import { gitMarkFor, useGitStatus } from './explorer/useGitStatus.js';

/** Poll cadence for the active project tree — new files/dirs created by an
 *  autonomous run appear within this window with no user action. Not fs.watch:
 *  inotify watchers over 50k-entry trees (the fork cap) exhaust watcher
 *  limits, and a rebuilt fork would burst change events. Polling expanded
 *  dirs only is cheap and the change-guard below skips re-renders. */
const EXPLORER_POLL_MS = 3000;
const ERROR_CLEAR_MS = 4000;
const GIT_MARK_TITLES: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
};
const HIDDEN_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

function isHiddenName(name: string): boolean {
  return name.startsWith('.') || HIDDEN_DIRS.has(name);
}

function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function parentOf(p: string): string {
  const cut = p.lastIndexOf(sepOf(p));
  return cut > 0 ? p.slice(0, cut) : p;
}

/** Change dot class for a git mark: staged renames render as modified. */
function dotClassFor(mark: string): string {
  if (mark === 'A') return 'git-a';
  if (mark === 'D') return 'git-d';
  if (mark === '?') return 'git-u';
  return 'git-m';
}

interface ExplorerProps {
  projects: Project[];
  activePath: string | null;
  activeProjectPath: string | null;
  onOpenProject(path: string): void;
  onRemoveProject(path: string): void;
  onAddFolder(): void;
  onOpenFile(path: string): void;
}

interface TreeRowProps {
  entry: FsEntry;
  depth: number;
  children: FsEntry[] | null;
  expanded: boolean;
  dirs: Map<string, FsEntry[]>;
  expandedSet: Set<string>;
  loadingPaths: Set<string>;
  gitRoot: string | null;
  gitStatus: GitStatus | null;
  hideHidden: boolean;
  onToggleDir(path: string): void;
  onOpenFile(path: string): void;
  onMenu(entry: FsEntry, x: number, y: number): void;
}

function TreeRow(props: TreeRowProps): React.JSX.Element {
  const {
    entry, depth, children, expanded, dirs, expandedSet, loadingPaths,
    gitRoot, gitStatus, hideHidden, onToggleDir, onOpenFile, onMenu,
  } = props;
  const pad = { paddingLeft: `${10 + depth * 12}px` };
  const mark = gitMarkFor(entry.path, gitRoot ?? '', gitStatus);
  const dot = mark !== null && !entry.isDir ? (
    <span className={`git-dot ${dotClassFor(mark)}`} title={GIT_MARK_TITLES[mark] ?? mark} />
  ) : null;
  const kids =
    children === null ? null : hideHidden ? children.filter((c) => !isHiddenName(c.name)) : children;
  const rowMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(entry, e.clientX, e.clientY);
  };
  const kind = classifyFile(entry.name, entry.isDir);
  if (entry.isDir) {
    return (
      <li>
        <button
          type="button"
          className={`tree-row tree-row-${kind}`}
          style={pad}
          onClick={() => onToggleDir(entry.path)}
          onContextMenu={rowMenu}
        >
          <span className="tree-tick" aria-hidden="true" />
          <span className={`tree-chevron${expanded ? ' tree-chevron-open' : ''}`}>{expanded ? '▾' : '▸'}</span>
          <span className={`tree-name ${nameClassFor(kind)}`}>{entry.name}</span>
          {loadingPaths.has(entry.path) && <span className="tree-loading">…</span>}
        </button>
        {expanded && kids !== null && (
          <ul className="tree-children">
            {kids.map((c) => (
              <TreeRow
                key={c.path}
                entry={c}
                depth={depth + 1}
                dirs={dirs}
                expandedSet={expandedSet}
                loadingPaths={loadingPaths}
                gitRoot={gitRoot}
                gitStatus={gitStatus}
                hideHidden={hideHidden}
                children={expandedSet.has(c.path) ? (dirs.get(c.path) ?? null) : null}
                expanded={expandedSet.has(c.path)}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onMenu={onMenu}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={`tree-row tree-file tree-row-${kind}`}
        style={pad}
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={rowMenu}
      >
        <span className="tree-tick" aria-hidden="true" />
        <span className={`tree-name ${nameClassFor(kind)}`}>{entry.name}</span>
        {dot}
      </button>
    </li>
  );
}

type FormKind = 'file' | 'dir' | 'rename';

interface FormState {
  kind: FormKind;
  dirPath: string;
  entry: FsEntry | null;
}

interface MenuState {
  x: number;
  y: number;
  entry: FsEntry | null;
}

/**
 * The global left sidebar: projects plus, under the active project, its
 * filesystem (lazy per-directory), a hidden-files filter, git change marks
 * and per-row context menus (new / rename / trash). Clicking a file opens
 * it in the editor.
 */
export function Explorer(props: ExplorerProps): React.JSX.Element {
  const { projects, activePath, activeProjectPath, onOpenProject, onRemoveProject, onAddFolder, onOpenFile } = props;

  const [treeOpen, setTreeOpen] = useState(false);
  const [dirs, setDirs] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());
  const [hideHidden, setHideHidden] = useState(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<number | null>(null);
  const gitStatus = useGitStatus(activeProjectPath);

  const showError = useCallback((msg: string): void => {
    setError(msg);
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(null), ERROR_CLEAR_MS);
  }, []);
  useEffect(
    () => () => {
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    },
    [],
  );

  // hidden-files preference: seeded once, then live-synced from the
  // settings broadcast (the set below round-trips through it)
  useEffect(() => {
    let alive = true;
    void bridge
      .getSettings()
      .then((s) => {
        if (alive) setHideHidden(s.explorer?.hideHidden ?? true);
      })
      .catch(() => undefined);
    const off = bridge.onSettingsChanged((s) => setHideHidden(s.explorer?.hideHidden ?? true));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const toggleHidden = useCallback((): void => {
    void bridge
      .setSettings({ explorer: { hideHidden: !hideHidden } })
      .catch(() => showError('could not save the hidden-files preference'));
  }, [hideHidden, showError]);

  // per-path loading: expanding a second dir while a first is in flight must
  // not drop the second load
  const loadDir = useCallback(async (path: string): Promise<void> => {
    if (loadingRef.current.has(path)) return;
    loadingRef.current.add(path);
    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const entries = await bridge.listDir(path);
      setDirs((prev) => {
        const cur = prev.get(path);
        // unchanged listing → return the same Map reference so polling never
        // triggers a re-render (the tree is only re-rendered on real change)
        if (
          cur &&
          cur.length === entries.length &&
          cur.every((e, i) => e.name === entries[i]!.name && e.isDir === entries[i]!.isDir)
        ) {
          return prev;
        }
        return new Map(prev).set(path, entries);
      });
    } catch {
      setDirs((prev) => new Map(prev).set(path, []));
    } finally {
      loadingRef.current.delete(path);
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  // the active project's tree: open when it changes, close when it leaves
  useEffect(() => {
    setTreeOpen(activeProjectPath !== null);
    setExpanded(new Set());
    if (activeProjectPath !== null) void loadDir(activeProjectPath);
  }, [activeProjectPath, loadDir]);

  // auto-refresh: while the tree is open, re-list the root and every expanded
  // dir on a poll tick so new files/folders appear in real time (the change-
  // guard inside loadDir makes an unchanged tree a no-op re-render)
  useEffect(() => {
    if (activeProjectPath === null || !treeOpen) return;
    const id = window.setInterval(() => {
      void loadDir(activeProjectPath);
      for (const p of expanded) void loadDir(p);
    }, EXPLORER_POLL_MS);
    return () => window.clearInterval(id);
  }, [activeProjectPath, treeOpen, expanded, loadDir]);

  const toggleDir = useCallback(
    (path: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        void loadDir(path);
        return next;
      });
    },
    [loadDir],
  );

  const forgetDir = useCallback((path: string): void => {
    setDirs((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const submitName = useCallback(
    async (state: FormState, name: string): Promise<string | null> => {
      const target = joinPath(state.dirPath, name);
      try {
        if (state.kind === 'rename' && state.entry) {
          if (target === state.entry.path) return null;
          const siblings = await bridge.listDir(state.dirPath);
          if (siblings.some((s) => s.name === name && s.path !== state.entry!.path)) {
            return `${name} already exists`;
          }
          await bridge.renamePath(state.entry.path, target);
          if (state.entry.isDir) forgetDir(state.entry.path);
          void loadDir(state.dirPath);
          return null;
        }
        const siblings = await bridge.listDir(state.dirPath);
        if (siblings.some((s) => s.name === name)) return `${name} already exists`;
        if (state.kind === 'file') await bridge.createFile(target);
        else await bridge.mkdir(target);
        void loadDir(state.dirPath);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [forgetDir, loadDir],
  );

  const doDelete = useCallback(
    async (entry: FsEntry): Promise<void> => {
      try {
        await bridge.trashPath(entry.path);
        if (entry.isDir) forgetDir(entry.path);
        void loadDir(parentOf(entry.path));
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      }
    },
    [forgetDir, loadDir, showError],
  );

  const openForm = useCallback(
    (kind: FormKind, entry: FsEntry | null): void => {
      if (activeProjectPath === null) return;
      let dirPath: string;
      if (kind === 'rename' && entry) dirPath = parentOf(entry.path);
      else if (entry && entry.isDir) dirPath = entry.path;
      else dirPath = entry ? parentOf(entry.path) : activeProjectPath;
      setForm({ kind, dirPath, entry: kind === 'rename' ? entry : null });
    },
    [activeProjectPath],
  );

  const root = activeProjectPath !== null ? (dirs.get(activeProjectPath) ?? null) : null;
  const rootKids =
    root === null ? null : hideHidden ? root.filter((c) => !isHiddenName(c.name)) : root;

  const menuItems = (): React.JSX.Element[] => {
    if (menu === null || activeProjectPath === null) return [];
    const at = menu.entry;
    const items: React.JSX.Element[] = [];
    const add = (label: string, action: () => void): void => {
      items.push(
        <button
          type="button"
          key={label}
          className="term-menu-item"
          onClick={() => {
            setMenu(null);
            action();
          }}
        >
          {label}
        </button>,
      );
    };
    if (at === null || at.isDir) {
      add('new file', () => openForm('file', at));
      add('new folder', () => openForm('dir', at));
    }
    if (at !== null) {
      add('rename', () => openForm('rename', at));
      add('delete', () => setConfirmDelete(at));
    }
    return items;
  };

  return (
    <div className="explorer">
      <header className="pane-header explorer-header">
        <span className="pane-title">
          Projects<span className="explorer-count">{projects.length > 0 ? ` ${projects.length}` : ''}</span>
        </span>
        <div className="explorer-header-tools">
          {gitStatus?.branch != null && (
            <span className="explorer-branch" title="git branch">
              {gitStatus.branch}
            </span>
          )}
          <button
            type="button"
            className={`explorer-chip${hideHidden ? '' : ' explorer-chip-on'}`}
            title={hideHidden ? 'show hidden files' : 'hide hidden files'}
            onClick={toggleHidden}
          >
            hidden
          </button>
          <button type="button" className="tile-btn explorer-add" title="add folder" onClick={onAddFolder}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
              <path d="M5.5 1 V10 M1 5.5 H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
            </svg>
          </button>
        </div>
      </header>
      {projects.length === 0 ? (
        <div className="explorer-empty">
          no projects yet — open a terminal anywhere and it will appear here
        </div>
      ) : (
        <ul className="explorer-list">
          {projects.map((p) => {
            const active = activePath === p.path;
            const isActiveProject = activeProjectPath === p.path;
            return (
              <li
                key={p.path}
                className={`explorer-item${active ? ' explorer-item-active' : ''}`}
                title={p.path}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  // clicking the already-active project toggles its file
                  // tree; clicking another project switches to it
                  if (isActiveProject) setTreeOpen((v) => !v);
                  else onOpenProject(p.path);
                }}
              >
                <div className="explorer-item-main">
                  <div className="explorer-item-name">{p.name}</div>
                  <div className="explorer-item-path">{p.path}</div>
                </div>
                <button
                  type="button"
                  className="tile-btn explorer-item-remove"
                  title="remove project"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onRemoveProject(p.path)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
                  </svg>
                </button>
                {isActiveProject && treeOpen && (
                  <div
                    className="explorer-tree"
                    onMouseDown={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                      if (activeProjectPath === null) return;
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, entry: null });
                    }}
                  >
                    {rootKids === null ? (
                      <div className="tree-loading">…</div>
                    ) : (
                      <ul className="tree-children">
                        {rootKids.map((c) => (
                          <TreeRow
                            key={c.path}
                            entry={c}
                            depth={0}
                            dirs={dirs}
                            expandedSet={expanded}
                            loadingPaths={loadingPaths}
                            gitRoot={activeProjectPath}
                            gitStatus={gitStatus}
                            hideHidden={hideHidden}
                            children={expanded.has(c.path) ? (dirs.get(c.path) ?? null) : null}
                            expanded={expanded.has(c.path)}
                            onToggleDir={toggleDir}
                            onOpenFile={onOpenFile}
                            onMenu={(entry, x, y) => setMenu({ x, y, entry })}
                          />
                        ))}
                      </ul>
                    )}
                    {error !== null && <div className="explorer-error">{error}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {menu !== null && activeProjectPath !== null && (
        <>
          <div
            className="term-menu-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="term-menu" style={{ left: menu.x, top: menu.y }}>
            {menuItems()}
          </div>
        </>
      )}
      {form !== null && (
        <NameDialog
          key={`${form.kind}:${form.dirPath}:${form.entry?.path ?? ''}`}
          title={form.kind === 'rename' ? 'rename' : form.kind === 'file' ? 'new file' : 'new folder'}
          confirmLabel={form.kind === 'rename' ? 'rename' : 'create'}
          initial={form.kind === 'rename' ? (form.entry?.name ?? '') : ''}
          placeholder={form.kind === 'dir' ? 'folder name' : 'file name'}
          onSubmit={(name) => submitName(form, name)}
          onCancel={() => setForm(null)}
        />
      )}
      {confirmDelete !== null && (
        <Dialog title="delete" onClose={() => setConfirmDelete(null)}>
          <p className="explorer-confirm-text">move {confirmDelete.name} to trash?</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
              cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                const entry = confirmDelete;
                setConfirmDelete(null);
                void doDelete(entry);
              }}
            >
              move to trash
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
