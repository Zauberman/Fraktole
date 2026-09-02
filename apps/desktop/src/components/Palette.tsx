import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type ProjectFile } from '../ipc.js';
import { fuzzyScore } from '../fuzzy.js';
import '../styles/palette.css';

/** One runnable entry in the command palette — mirrors ShortcutDef's
 *  stable-id + display-keys model but carries its own action. */
export interface PaletteCommand {
  /** Stable id — tiebreak when label scores tie. */
  id: string;
  /** Display form, e.g. `New tile`. */
  label: string;
  /** Optional key hint, e.g. `Ctrl+Shift+T` (right-aligned, faint). */
  keys?: string;
  /** Group header the command renders under. */
  section: string;
  run: () => void;
}

interface PaletteProps {
  /** Project root for file mode; null hides file mode content. */
  root: string | null;
  /** Mode the palette opens in; `>` prefix toggles in-place afterwards. */
  initialMode: 'files' | 'commands';
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

interface FileRow {
  path: string;
  rel: string;
  dir: string;
  base: string;
  score: number;
}

interface CmdRow {
  cmd: PaletteCommand;
  score: number;
}

interface CmdGroup {
  section: string;
  rows: CmdRow[];
}

const MAX_ROWS = 200;
const PATH_MATCH_PENALTY = 4; // full-path hits rank below basename hits
const ID_MATCH_PENALTY = 4; // id hits rank below label hits

/** Strip the project-root prefix so rows show project-relative paths. */
function relPath(path: string, root: string | null): string {
  if (root === null) return path;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Split `dir/base` at the last separator; `dir` keeps its trailing `/`. */
function splitDir(rel: string): { dir: string; base: string } {
  const cut = rel.lastIndexOf('/');
  if (cut < 0) return { dir: '', base: rel };
  return { dir: rel.slice(0, cut + 1), base: rel.slice(cut + 1) };
}

/**
 * Unified command palette (Ctrl+P files / Ctrl+Shift+P commands). Two
 * modes in one input: file search over `bridge.listProjectFiles(root)`
 * and command search over the `commands` registry. Typing `>` as the
 * first character switches to command mode; deleting back past it
 * returns to file mode. Esc or an outside click closes.
 */
export function Palette(props: PaletteProps): React.JSX.Element {
  const { root, initialMode, commands, onOpenFile, onClose } = props;
  // The raw query keeps the leading `>` while in command mode — mode is
  // derived from it, so the `>` char itself does the switching.
  const [query, setQuery] = useState(initialMode === 'commands' ? '>' : '');
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selRowRef = useRef<HTMLLIElement | null>(null);

  const mode: 'files' | 'commands' = query.startsWith('>') ? 'commands' : 'files';
  const q = (mode === 'commands' ? query.slice(1) : query).trim();

  useEffect(() => {
    setQuery(initialMode === 'commands' ? '>' : '');
  }, [initialMode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSel(0);
  }, [q, mode]);

  useEffect(() => {
    if (!root) {
      setFiles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void bridge
      .listProjectFiles(root)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFiles([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const fileRows = useMemo<FileRow[]>(() => {
    if (q.length === 0) {
      return files.slice(0, MAX_ROWS).map((f) => {
        const rel = relPath(f.path, root);
        const { dir, base } = splitDir(rel);
        return { path: f.path, rel, dir, base, score: 0 };
      });
    }
    const scored: FileRow[] = [];
    for (const f of files) {
      const rel = relPath(f.path, root);
      const { dir, base } = splitDir(rel);
      const bs = fuzzyScore(q, base);
      const ps = fuzzyScore(q, rel);
      const score =
        bs !== null && ps !== null
          ? Math.max(bs, ps - PATH_MATCH_PENALTY)
          : bs !== null
            ? bs
            : ps !== null
              ? ps - PATH_MATCH_PENALTY
              : null;
      if (score === null) continue;
      scored.push({ path: f.path, rel, dir, base, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.rel.length - b.rel.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return scored.slice(0, MAX_ROWS);
  }, [files, q, root]);

  const cmdGroups = useMemo<CmdGroup[]>(() => {
    const ranked: CmdRow[] = [];
    for (const cmd of commands) {
      const ls = q.length === 0 ? 0 : fuzzyScore(q, cmd.label);
      const is = q.length === 0 ? null : fuzzyScore(q, cmd.id);
      const score = ls !== null ? ls : is !== null ? is - ID_MATCH_PENALTY : null;
      if (score === null) continue;
      ranked.push({ cmd, score });
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        (a.cmd.label < b.cmd.label ? -1 : a.cmd.label > b.cmd.label ? 1 : 0) ||
        (a.cmd.id < b.cmd.id ? -1 : a.cmd.id > b.cmd.id ? 1 : 0),
    );
    const groups: CmdGroup[] = [];
    const bySection = new Map<string, CmdGroup>();
    for (const row of ranked) {
      let group = bySection.get(row.cmd.section);
      if (!group) {
        group = { section: row.cmd.section, rows: [] };
        bySection.set(row.cmd.section, group);
        groups.push(group);
      }
      group.rows.push(row);
    }
    return groups;
  }, [commands, q]);

  const flatCmds = useMemo(() => cmdGroups.flatMap((g) => g.rows), [cmdGroups]);
  const rows = mode === 'commands' ? flatCmds.length : fileRows.length;
  const selIdx = rows === 0 ? 0 : Math.min(sel, rows - 1);

  useEffect(() => {
    selRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selIdx, q, mode]);

  const runCommand = (row: CmdRow) => {
    row.cmd.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      if (mode === 'files') {
        const hit = fileRows[selIdx];
        if (hit) onOpenFile(hit.path);
      } else {
        const hit = flatCmds[selIdx];
        if (hit) runCommand(hit);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (rows === 0 ? 0 : (Math.min(s, rows - 1) + 1) % rows));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (rows === 0 ? 0 : (Math.min(s, rows - 1) - 1 + rows) % rows));
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setSel(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setSel(Math.max(0, rows - 1));
      return;
    }
    e.stopPropagation();
  };

  const fileItems = fileRows.map((row, i) => (
    <li
      key={row.path}
      id={`palette-opt-${i}`}
      role="option"
      aria-selected={i === selIdx}
      className={`palette-row${i === selIdx ? ' palette-row-selected' : ''}`}
      ref={i === selIdx ? selRowRef : undefined}
      onMouseEnter={() => setSel(i)}
      onClick={() => onOpenFile(row.path)}
    >
      {row.dir !== '' && <span className="palette-row-dir">{row.dir}</span>}
      <span className="palette-row-name">{row.base}</span>
    </li>
  ));

  const cmdItems: React.JSX.Element[] = [];
  let idx = 0;
  for (const group of cmdGroups) {
    cmdItems.push(
      <li key={`sec:${group.section}`} className="palette-section" role="presentation">
        {group.section}
      </li>,
    );
    for (const row of group.rows) {
      const selected = idx === selIdx;
      cmdItems.push(
        <li
          key={row.cmd.id}
          id={`palette-opt-${idx}`}
          role="option"
          aria-selected={selected}
          className={`palette-row${selected ? ' palette-row-selected' : ''}`}
          ref={selected ? selRowRef : undefined}
          onMouseEnter={() => setSel(idx)}
          onClick={() => runCommand(row)}
        >
          <span className="palette-row-name">{row.cmd.label}</span>
          {row.cmd.keys !== undefined && row.cmd.keys !== '' && (
            <span className="palette-row-keys">{row.cmd.keys}</span>
          )}
        </li>,
      );
      idx += 1;
    }
  }

  const countLabel = loading
    ? 'loading…'
    : mode === 'commands'
      ? `${flatCmds.length} command${flatCmds.length === 1 ? '' : 's'}`
      : `${fileRows.length} file${fileRows.length === 1 ? '' : 's'}`;

  const emptyState = (() => {
    if (loading) return null;
    if (mode === 'files' && !root) return 'open a project to search files';
    if (mode === 'commands' && commands.length === 0) return 'no commands';
    if (rows === 0) return q.length > 0 ? `no matches for ${q}` : 'no matches';
    return null;
  })();

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog palette">
        <div className="palette-inputrow">
          <span className="palette-mode">{mode === 'commands' ? 'cmd' : 'file'}</span>
          <input
            ref={inputRef}
            className="dialog-input"
            value={query}
            placeholder={
              mode === 'commands'
                ? 'type to filter commands'
                : root
                  ? `find in ${root}`
                  : 'no project root'
            }
            spellCheck={false}
            aria-label="palette search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={`palette-opt-${selIdx}`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-count">{countLabel}</div>
        {rows > 0 && (
          <ul
            id="palette-list"
            className="palette-list"
            role="listbox"
            aria-label={mode === 'commands' ? 'commands' : 'files'}
          >
            {mode === 'commands' ? cmdItems : fileItems}
          </ul>
        )}
        {emptyState !== null && <div className="palette-empty">{emptyState}</div>}
      </div>
    </div>
  );
}
