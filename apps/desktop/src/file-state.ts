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

  const openFile = useCallback(async (path: string): Promise<void> => {
    // already open? just activate
    if (filesRef.current.some((f) => f.path === path)) {
      setActivePath(path);
      return;
    }
    try {
      const st = await bridge.statFile(path);
      const readOnly = st.size > MAX_EDITABLE;
      const { content } = await bridge.readFile(path);
      const name = path.split('/').pop() ?? path;
      setFiles((prev) => [...prev, { path, name, content, lang: langFor(path), dirty: false, readOnly }]);
      setActivePath(path);
    } catch {
      // unreadable file — stay put
    }
  }, []);

  const activate = useCallback((path: string): void => {
    setActivePath(path);
  }, []);

  const closeFile = useCallback((path: string): void => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      return next;
    });
    setActivePath((cur) => (cur === path ? null : cur));
  }, []);

  const updateContent = useCallback((path: string, content: string): void => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }, []);

  const saveFile = useCallback(async (path: string): Promise<boolean> => {
    const f = filesRef.current.find((x) => x.path === path);
    if (!f || f.readOnly) return false;
    try {
      await bridge.writeFile(path, f.content);
      setFiles((prev) => prev.map((x) => (x.path === path ? { ...x, dirty: false } : x)));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { files, activePath, openFile, activate, closeFile, updateContent, saveFile };
}
