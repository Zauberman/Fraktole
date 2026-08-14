import React, { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type FsEntry, type Project } from '../ipc.js';

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
  onToggleDir(path: string): void;
  onOpenFile(path: string): void;
}

function TreeRow(props: TreeRowProps): React.JSX.Element {
  const { entry, depth, children, expanded, dirs, expandedSet, loadingPaths, onToggleDir, onOpenFile } = props;
  const pad = { paddingLeft: `${10 + depth * 12}px` };
  if (entry.isDir) {
    return (
      <li>
        <button type="button" className="tree-row" style={pad} onClick={() => onToggleDir(entry.path)}>
          <span className={`tree-chevron${expanded ? ' tree-chevron-open' : ''}`}>{expanded ? '▾' : '▸'}</span>
          <span className="tree-name">{entry.name}</span>
          {loadingPaths.has(entry.path) && <span className="tree-loading">…</span>}
        </button>
        {expanded && children !== null && (
          <ul className="tree-children">
            {children.map((c) => (
              <TreeRow
                key={c.path}
                entry={c}
                depth={depth + 1}
                dirs={dirs}
                expandedSet={expandedSet}
                loadingPaths={loadingPaths}
                children={expandedSet.has(c.path) ? (dirs.get(c.path) ?? null) : null}
                expanded={expandedSet.has(c.path)}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="tree-row tree-file" style={pad} onClick={() => onOpenFile(entry.path)}>
        <span className="tree-name">{entry.name}</span>
      </button>
    </li>
  );
}

/**
 * The global left sidebar: projects plus, under the active project, its
 * filesystem (lazy per-directory). Clicking a file opens it in the editor.
 */
export function Explorer(props: ExplorerProps): React.JSX.Element {
  const { projects, activePath, activeProjectPath, onOpenProject, onRemoveProject, onAddFolder, onOpenFile } = props;

  const [treeOpen, setTreeOpen] = useState(false);
  const [dirs, setDirs] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());

  // per-path loading: expanding a second dir while a first is in flight must
  // not drop the second load
  const loadDir = useCallback(async (path: string): Promise<void> => {
    if (loadingRef.current.has(path)) return;
    loadingRef.current.add(path);
    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const entries = await bridge.listDir(path);
      setDirs((prev) => new Map(prev).set(path, entries));
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

  const root = activeProjectPath !== null ? (dirs.get(activeProjectPath) ?? null) : null;

  return (
    <div className="explorer">
      <header className="pane-header explorer-header">
        <span className="pane-title">
          Projects<span className="explorer-count">{projects.length > 0 ? ` ${projects.length}` : ''}</span>
        </span>
        <button type="button" className="tile-btn explorer-add" title="add folder" onClick={onAddFolder}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <path d="M5.5 1 V10 M1 5.5 H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
          </svg>
        </button>
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
                  <div className="explorer-tree" onMouseDown={(e) => e.stopPropagation()}>
                    {root === null ? (
                      <div className="tree-loading">…</div>
                    ) : (
                      <ul className="tree-children">
                        {root.map((c) => (
                          <TreeRow
                            key={c.path}
                            entry={c}
                            depth={0}
                            dirs={dirs}
                            expandedSet={expanded}
                            loadingPaths={loadingPaths}
                            children={expanded.has(c.path) ? (dirs.get(c.path) ?? null) : null}
                            expanded={expanded.has(c.path)}
                            onToggleDir={toggleDir}
                            onOpenFile={onOpenFile}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
