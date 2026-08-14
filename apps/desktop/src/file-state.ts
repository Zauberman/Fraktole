import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './ipc.js';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  lang: string;
  dirty: boolean;
  readOnly: boolean;
}

const MAX_EDITABLE = 1_000_000;

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

export interface FileEditorState {
  files: OpenFile[];
  activePath: string | null;
  openFile(path: string): Promise<void>;
  activate(path: string): void;
  closeFile(path: string): void;
  updateContent(path: string, content: string): void;
  saveFile(path: string): Promise<boolean>;
}

/**
 * Open files of the active project. Kept per project (the component is
 * keyed by projectPath); not persisted across restarts.
 */
export function useFileEditor(): FileEditorState {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  // latest content, updated synchronously with each edit so a save issued in
  // the same task as the last keystroke can never write stale bytes
  const contentRef = useRef<Map<string, string>>(new Map());

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
        prev.some((f) => f.path === path) ? prev : [...prev, { path, name, content, lang: langFor(path), dirty: false, readOnly }],
      );
      setActivePath(path);
    } catch {
      // unreadable file — stay put
    }
  }, []);

  const activate = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const closeFile = useCallback((path: string): void => {
    const f = filesRef.current.find((x) => x.path === path);
    if (f && f.dirty && !window.confirm(`Discard unsaved changes in "${f.name}"?`)) return;
    contentRef.current.delete(path);
    setFiles((prev) => prev.filter((f2) => f2.path !== path));
    setActivePath((cur) => (cur === path ? null : cur));
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
      setFiles((prev) => prev.map((x) => (x.path === path ? { ...x, dirty: false } : x)));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { files, activePath, openFile, activate, closeFile, updateContent, saveFile };
}
