import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './ipc.js';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  lang: string;
  dirty: boolean;
  readOnly: boolean;
  /** The file changed on disk after it was opened (fs watcher event). */
  stale: boolean;
}

const MAX_EDITABLE = 1_000_000;
const MAX_PERSISTED_TABS = 20;

export function langFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'javascript';
  if (['json', 'jsonc'].includes(ext)) return 'json';
  if (['py'].includes(ext)) return 'python';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['css'].includes(ext)) return 'css';
  return 'plaintext';
}

/** Activation target after closing a tab: the right neighbor, else the
 *  left one, else null (no tab left). Pure so tests can pin the order. */
export function neighborAfterClose(files: readonly { path: string }[], closedPath: string): string | null {
  const idx = files.findIndex((f) => f.path === closedPath);
  if (idx === -1) return null;
  return (files[idx + 1] ?? files[idx - 1])?.path ?? null;
}

/** Flag the file at `path` as changed on disk; identity-stable when the
 *  list does not contain it (or it is already stale) to avoid re-renders. */
export function markStale(files: OpenFile[], path: string): OpenFile[] {
  let changed = false;
  const next = files.map((f) => {
    if (f.path !== path || f.stale) return f;
    changed = true;
    return { ...f, stale: true };
  });
  return changed ? next : files;
}

/** A local save landed: clear dirty and stale for that one file. */
export function markSaved(files: OpenFile[], path: string): OpenFile[] {
  let changed = false;
  const next = files.map((f) => {
    if (f.path !== path || (!f.dirty && !f.stale)) return f;
    changed = true;
    return { ...f, dirty: false, stale: false };
  });
  return changed ? next : files;
}

/** One persisted tab entry (localStorage, namespaced per project). */
export interface PersistedTab {
  path: string;
  active: boolean;
}

export function tabsStorageKey(projectPath: string): string {
  return `fraktole.openTabs.${projectPath}`;
}

/** The open-tab list to persist: max 20 entries, active always kept. */
export function serializeTabs(files: readonly OpenFile[], activePath: string | null): PersistedTab[] {
  const entries = files.map((f) => ({ path: f.path, active: f.path === activePath }));
  if (entries.length <= MAX_PERSISTED_TABS) return entries;
  const kept = entries.slice(0, MAX_PERSISTED_TABS);
  if (activePath !== null && !kept.some((t) => t.path === activePath)) {
    kept[MAX_PERSISTED_TABS - 1] = { path: activePath, active: true };
  }
  return kept;
}

/** Tolerant parse: junk, wrong shapes, empty paths and duplicates are
 *  dropped so a corrupted entry can never break tab restore. */
export function parsePersistedTabs(raw: string | null): PersistedTab[] {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: PersistedTab[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== 'string' || path.length === 0) continue;
    if (out.some((t) => t.path === path)) continue;
    out.push({ path, active: (entry as { active?: unknown }).active === true });
  }
  return out.length > MAX_PERSISTED_TABS ? out.slice(0, MAX_PERSISTED_TABS) : out;
}

export function loadPersistedTabs(projectPath: string, storage: Pick<Storage, 'getItem'>): PersistedTab[] {
  try {
    return parsePersistedTabs(storage.getItem(tabsStorageKey(projectPath)));
  } catch {
    return [];
  }
}

export function savePersistedTabs(projectPath: string, tabs: PersistedTab[], storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(tabsStorageKey(projectPath), JSON.stringify(tabs));
  } catch {
    // storage unavailable — persistence is best effort
  }
}

/** One-shot request to select and center a line in an open editor. The
 *  nonce lets repeated reveals of the same line re-trigger the pane. */
export interface RevealRequest {
  path: string;
  line: number;
  nonce: number;
}

export interface FileEditorOptions {
  /** Toast sink: save failures and save-all counts are surfaced here. */
  onNotice?(message: string): void;
}

export interface FileEditorState {
  files: OpenFile[];
  activePath: string | null;
  reveal: RevealRequest | null;
  openFile(path: string): Promise<void>;
  activate(path: string): void;
  /** Closes unconditionally — dirty confirmation lives in the editor UI. */
  closeFile(path: string): void;
  updateContent(path: string, content: string): void;
  saveFile(path: string): Promise<boolean>;
  /** Saves every dirty file; resolves with the number saved. */
  saveAll(): Promise<number>;
  /** Re-reads the file from disk, clearing dirty and stale. */
  reloadFile(path: string): Promise<boolean>;
  /** Keeps the local copy: dismisses the changed-on-disk banner. */
  dismissStale(path: string): void;
  /** Re-opens the tabs persisted for `projectPath` (swallows per-file
   *  errors) and re-activates the persisted active one. */
  restoreTabs(projectPath: string): Promise<void>;
  /** Search-panel entry: activate the file, select and center the line. */
  revealLine(path: string, line: number): void;
}

/**
 * Open files of the active project. Kept per project in memory; the open-tab
 * list persists per project in localStorage so tabs survive a restart.
 */
export function useFileEditor(options: FileEditorOptions = {}): FileEditorState {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  // latest content, updated synchronously with each edit so a save issued in
  // the same task as the last keystroke can never write stale bytes
  const contentRef = useRef<Map<string, string>>(new Map());
  // project the tab list persists under; set by restoreTabs
  const projectRef = useRef<string | null>(null);
  const lastPersistRef = useRef('');
  const revealNonceRef = useRef(0);
  const onNoticeRef = useRef(options.onNotice);
  onNoticeRef.current = options.onNotice;

  const openFile = useCallback(async (path: string): Promise<void> => {
    // already open? just activate
    if (filesRef.current.some((f) => f.path === path)) {
      setActivePath(path);
      return;
    }
    try {
      const st = await bridge.statFile(path);
      const readOnly = st.size > MAX_EDITABLE;
      // a file too large to edit must not be read into memory at all
      const { content } = readOnly ? { content: '' } : await bridge.readFile(path);
      const name = path.split('/').pop() ?? path;
      setFiles((prev) =>
        // dedupe inside the updater: two concurrent openFile calls for the
        // same path must not register the file twice
        prev.some((f) => f.path === path) ? prev : [...prev, { path, name, content, lang: langFor(path), dirty: false, readOnly, stale: false }],
      );
      setActivePath(path);
      void bridge.watchFile(path);
    } catch {
      // unreadable file — stay put
    }
  }, []);

  const activate = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const closeFile = useCallback((path: string): void => {
    const cur = filesRef.current;
    if (!cur.some((f) => f.path === path)) return;
    contentRef.current.delete(path);
    setFiles(cur.filter((f) => f.path !== path));
    setActivePath((active) => (active === path ? neighborAfterClose(cur, path) : active));
    void bridge.unwatchFile(path);
  }, []);

  const updateContent = useCallback((path: string, content: string): void => {
    contentRef.current.set(path, content);
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }, []);

  const saveFile = useCallback(async (path: string): Promise<boolean> => {
    const f = filesRef.current.find((x) => x.path === path);
    if (!f || f.readOnly) return false;
    const content = contentRef.current.get(path) ?? f.content;
    try {
      await bridge.writeFile(path, content);
      setFiles((prev) => markSaved(prev, path));
      return true;
    } catch {
      onNoticeRef.current?.(`failed to save ${f.name}`);
      return false;
    }
  }, []);

  const saveAll = useCallback(
    async (): Promise<number> => {
      const dirty = filesRef.current.filter((f) => f.dirty && !f.readOnly);
      let saved = 0;
      for (const f of dirty) {
        if (await saveFile(f.path)) saved += 1;
      }
      if (dirty.length > 0) onNoticeRef.current?.(`saved ${saved} of ${dirty.length} files`);
      return saved;
    },
    [saveFile],
  );

  const reloadFile = useCallback(async (path: string): Promise<boolean> => {
    const f = filesRef.current.find((x) => x.path === path);
    if (!f) return false;
    try {
      const { content } = await bridge.readFile(path);
      contentRef.current.set(path, content);
      setFiles((prev) => prev.map((x) => (x.path === path ? { ...x, content, dirty: false, stale: false } : x)));
      return true;
    } catch {
      onNoticeRef.current?.(`failed to reload ${f.name}`);
      return false;
    }
  }, []);

  const dismissStale = useCallback((path: string): void => {
    setFiles((prev) => prev.map((f) => (f.path === path && f.stale ? { ...f, stale: false } : f)));
  }, []);

  const restoreTabs = useCallback(
    async (projectPath: string): Promise<void> => {
      // repeated calls for the project already restored are a no-op: a
      // re-restore would silently drop unsaved edits
      if (projectRef.current === projectPath) return;
      projectRef.current = projectPath;
      lastPersistRef.current = '';
      // drop the previous project's tabs (their watchers stop with them)
      for (const f of [...filesRef.current]) closeFile(f.path);
      // read before any await: the close above only flushes at the first one
      const tabs = loadPersistedTabs(projectPath, localStorage);
      const active = tabs.find((t) => t.active)?.path ?? null;
      for (const t of tabs) {
        await openFile(t.path);
      }
      if (active !== null && filesRef.current.some((f) => f.path === active)) activate(active);
    },
    [activate, closeFile, openFile],
  );

  const revealLine = useCallback(
    (path: string, line: number): void => {
      const emit = (): void => {
        revealNonceRef.current += 1;
        setReveal({ path, line, nonce: revealNonceRef.current });
      };
      if (filesRef.current.some((f) => f.path === path)) {
        setActivePath(path);
        emit();
        return;
      }
      void openFile(path).then(() => {
        // openFile stays silent on unreadable files; only reveal on success
        if (filesRef.current.some((f) => f.path === path)) emit();
      });
    },
    [openFile],
  );

  // persist the open-tab list on every open/close/activate; identical
  // serializations (every keystroke also lands here) skip the write
  useEffect(() => {
    const project = projectRef.current;
    if (project === null) return;
    const tabs = serializeTabs(files, activePath);
    const json = JSON.stringify(tabs);
    if (json === lastPersistRef.current) return;
    lastPersistRef.current = json;
    savePersistedTabs(project, tabs, localStorage);
  }, [files, activePath]);

  // one global watcher subscription: a changed file is marked stale until
  // it is reloaded, dismissed or saved again
  useEffect(() => {
    return bridge.onFileChanged((path) => {
      setFiles((prev) => markStale(prev, path));
    });
  }, []);

  // stop watching everything on teardown
  useEffect(
    () => () => {
      for (const f of filesRef.current) void bridge.unwatchFile(f.path);
    },
    [],
  );

  return { files, activePath, reveal, openFile, activate, closeFile, updateContent, saveFile, saveAll, reloadFile, dismissStale, restoreTabs, revealLine };
}
