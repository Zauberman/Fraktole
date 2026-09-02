import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { CodeMirrorPane } from './editor/CodeMirrorPane.js';
import { useEditorSettings } from './editor/use-editor-settings.js';
import type { OpenFile, RevealRequest } from '../file-state.js';
import '../styles/editor.css';

interface FileEditorProps {
  projectPath: string | null;
  files: OpenFile[];
  activePath: string | null;
  /** One-shot reveal request from the project-search panel. */
  reveal?: RevealRequest | null;
  onActivate(path: string): void;
  /** Closes unconditionally — the dirty confirmation lives in here. */
  onClose(path: string): void;
  onUpdate(path: string, content: string): void;
  onSave(path: string): Promise<boolean>;
  /** Save-all action (orchestrator-wired); the button only shows when any
   *  tab is dirty. */
  onSaveAll?(): void;
  /** Re-read a file from disk (stale-banner reload). */
  onReload?(path: string): Promise<boolean>;
  /** Dismiss the changed-on-disk banner (keep the local copy). */
  onDismissStale?(path: string): void;
}

/** A close/reload waiting on the discard dialog: the dirty files to save
 *  first, the files to close afterwards, or the single file to reload. */
interface PendingAction {
  savePaths: string[];
  closePaths: string[];
  reloadPath: string | null;
}

const AUTOSAVE_DELAY_MS = 800;

/**
 * The File Editor tab: open files as sub-tabs, one CodeMirror editor each
 * (kept mounted so scroll positions survive tab switches), Ctrl+S saves,
 * changed-on-disk banners, a discard dialog on close/reload of dirty files,
 * middle-click close, a tab overflow menu and save-all.
 */
export function FileEditor(props: FileEditorProps): React.JSX.Element {
  const { projectPath, files, activePath, reveal, onActivate, onClose, onUpdate, onSave, onSaveAll, onReload, onDismissStale } = props;
  const settings = useEditorSettings();

  // discard dialog (non-blocking, replaces window.confirm)
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  // autoSave: debounced save 800ms after the last edit of each file
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const saveTimersRef = useRef<Map<string, number>>(new Map());
  const handleUpdate = useCallback(
    (path: string, content: string): void => {
      onUpdate(path, content);
      if (!settingsRef.current.autoSave) return;
      const timers = saveTimersRef.current;
      const at = timers.get(path);
      if (at !== undefined) window.clearTimeout(at);
      timers.set(
        path,
        window.setTimeout(() => {
          timers.delete(path);
          void onSaveRef.current(path);
        }, AUTOSAVE_DELAY_MS),
      );
    },
    [onUpdate],
  );
  useEffect(
    () => () => {
      for (const at of saveTimersRef.current.values()) window.clearTimeout(at);
    },
    [],
  );

  // tab-strip overflow: track scrollability for the "…" button
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = (): void => setScrollable(el.scrollWidth > el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [files, activePath]);

  // overflow dropdown, positioned like the terminal context menu
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const openMenu = useCallback((): void => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setMenuOpen(true);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  /** Close these paths now, or park them behind the discard dialog when
   *  any of them is dirty. */
  const requestClose = useCallback(
    (closePaths: string[]): void => {
      const dirty = files.filter((f) => f.dirty && closePaths.includes(f.path)).map((f) => f.path);
      if (dirty.length === 0) {
        for (const p of closePaths) onClose(p);
        return;
      }
      setPending({ savePaths: dirty, closePaths, reloadPath: null });
    },
    [files, onClose],
  );

  /** Reload a (possibly dirty) file: the dirty case goes through the
   *  discard dialog first. */
  const requestReload = useCallback(
    (path: string): void => {
      const f = files.find((x) => x.path === path);
      if (f?.dirty) {
        setPending({ savePaths: [path], closePaths: [], reloadPath: path });
        return;
      }
      void onReload?.(path);
    },
    [files, onReload],
  );

  const resolvePending = useCallback(
    async (save: boolean): Promise<void> => {
      if (!pending) return;
      if (save) {
        setBusy(true);
        let ok = true;
        for (const p of pending.savePaths) {
          if (!(await onSave(p))) ok = false;
        }
        setBusy(false);
        if (!ok) {
          // a failed save keeps every file open (notice was surfaced)
          setPending(null);
          return;
        }
      }
      setPending(null);
      if (pending.reloadPath !== null) {
        await onReload?.(pending.reloadPath);
        return;
      }
      for (const p of pending.closePaths) onClose(p);
    },
    [pending, onSave, onReload, onClose],
  );

  const dirtyCount = files.filter((f) => f.dirty).length;
  const keepPath = activePath ?? files[0]?.path ?? null;
  const pendingNames = pending ? files.filter((f) => pending.savePaths.includes(f.path)) : [];

  return (
    <div className="file-editor">
      {projectPath === null ? (
        <div className="orch-hint reviewer-hint">open a project to browse and edit its files</div>
      ) : files.length === 0 ? (
        <div className="orch-hint reviewer-hint">
          no files open — click a file in the left sidebar ({projectPath})
        </div>
      ) : (
        <>
          <div className="editor-tabbar">
            <div className="editor-tabstrip" ref={stripRef}>
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`file-tab${f.path === activePath ? ' file-tab-active' : ''}`}
                  title={f.path}
                  onClick={() => onActivate(f.path)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      requestClose([f.path]);
                    }
                  }}
                >
                  <span className="file-tab-name">{f.name}</span>
                  {f.dirty && <span className="file-tab-dirty">●</span>}
                  {f.readOnly && <span className="file-tab-ro">ro</span>}
                  <span
                    className="file-tab-close"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose([f.path]);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') requestClose([f.path]);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
            {dirtyCount > 0 && onSaveAll !== undefined && (
              <button type="button" className="btn btn-sm editor-saveall" onClick={onSaveAll}>
                save all
              </button>
            )}
            {scrollable && (
              <button
                ref={moreRef}
                type="button"
                className="editor-tabbar-more"
                aria-label="all tabs"
                title="all tabs"
                onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
              >
                …
              </button>
            )}
          </div>
          <div className="file-editor-body">
            {files.map((f) => (
              <div key={f.path} className={`file-editor-pane${f.path === activePath ? '' : ' file-editor-pane-hidden'}`}>
                {f.stale && (
                  <div className="editor-stale">
                    <span className="editor-stale-text">{f.name} changed on disk</span>
                    <span className="editor-stale-actions">
                      <button type="button" className="btn btn-sm" onClick={() => requestReload(f.path)}>
                        reload
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => onDismissStale?.(f.path)}>
                        keep mine
                      </button>
                    </span>
                  </div>
                )}
                <CodeMirrorPane file={f} settings={settings} reveal={reveal ?? null} onUpdate={handleUpdate} onSave={onSave} />
              </div>
            ))}
          </div>
        </>
      )}
      {pending !== null && (
        <Dialog
          title={pending.reloadPath !== null ? 'reload file' : 'unsaved changes'}
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void resolvePending(true)}>
                save
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resolvePending(false)}>
                discard
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPending(null)}>
                cancel
              </button>
            </>
          }
        >
          <p className="editor-dialog-text">
            {pending.reloadPath !== null
              ? 'discard local changes and reload?'
              : pendingNames.length === 1
                ? `discard unsaved changes in "${pendingNames[0]?.name ?? ''}"?`
                : `discard unsaved changes in ${pendingNames.length} files?`}
          </p>
        </Dialog>
      )}
      {menuOpen && (
        <>
          <div className="editor-menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
          <div className="editor-menu" style={{ top: menuPos.top, right: menuPos.right }}>
            <div className="editor-menu-list">
              {files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`editor-menu-item${f.path === activePath ? ' editor-menu-item-active' : ''}`}
                  onClick={() => {
                    onActivate(f.path);
                    setMenuOpen(false);
                  }}
                >
                  <span className="editor-menu-name">{f.name}</span>
                  {f.dirty && <span className="file-tab-dirty">●</span>}
                  {f.readOnly && <span className="file-tab-ro">ro</span>}
                </button>
              ))}
            </div>
            <div className="editor-menu-sep" />
            <button
              type="button"
              className="editor-menu-item"
              disabled={files.length <= 1}
              onClick={() => {
                requestClose(files.map((f) => f.path).filter((p) => p !== keepPath));
                setMenuOpen(false);
              }}
            >
              close others
            </button>
            <button
              type="button"
              className="editor-menu-item"
              onClick={() => {
                requestClose(files.map((f) => f.path));
                setMenuOpen(false);
              }}
            >
              close all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
