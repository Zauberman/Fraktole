import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/explorer.css';
import { bridge, type SearchResult } from '../ipc.js';
import type { SearchHit } from '../shared/ipc.js';

const SEARCH_DEBOUNCE_MS = 350;

export interface SearchPanelProps {
  root: string;
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}

interface SearchGroup {
  path: string;
  hits: SearchHit[];
}

function relativePath(abs: string, root: string): string {
  const norm = abs.replace(/\\/g, '/');
  const normRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (norm.startsWith(`${normRoot}/`)) return norm.slice(normRoot.length + 1);
  const cut = norm.lastIndexOf('/');
  return cut >= 0 ? norm.slice(cut + 1) : norm;
}

function groupHits(hits: SearchHit[]): SearchGroup[] {
  const groups: SearchGroup[] = [];
  const byPath = new Map<string, SearchGroup>();
  for (const hit of hits) {
    let g = byPath.get(hit.path);
    if (g === undefined) {
      g = { path: hit.path, hits: [] };
      byPath.set(hit.path, g);
      groups.push(g);
    }
    g.hits.push(hit);
  }
  return groups;
}

/** Splits a hit line into plain text and query matches (case-insensitive),
 *  rendered as mark-highlighted fragments. */
function highlight(text: string, query: string): React.JSX.Element {
  const out: React.JSX.Element[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let from = 0;
  let key = 0;
  while (from <= text.length) {
    const at = lowerQuery.length === 0 ? -1 : lowerText.indexOf(lowerQuery, from);
    if (at < 0) {
      if (from < text.length) out.push(<span key={key++}>{text.slice(from)}</span>);
      break;
    }
    if (at > from) out.push(<span key={key++}>{text.slice(from, at)}</span>);
    out.push(
      <mark key={key++} className="search-hit-mark">
        {text.slice(at, at + query.length)}
      </mark>,
    );
    from = at + query.length;
  }
  return <span className="search-text">{out}</span>;
}

/** Project-wide text search overlay: debounced live query against
 *  bridge.searchProject, results grouped per file, keyboard driven. */
export function SearchPanel(props: SearchPanelProps): React.JSX.Element {
  const { root, onClose, onOpen } = props;
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const reqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    const id = window.setTimeout(() => {
      if (q.length === 0) {
        reqRef.current++;
        setResult(null);
        setError(null);
        setLoading(false);
        return;
      }
      const req = ++reqRef.current;
      setLoading(true);
      void bridge
        .searchProject(root, q)
        .then((r) => {
          if (reqRef.current !== req) return;
          setResult(r);
          setError(null);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (reqRef.current !== req) return;
          setResult(null);
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, root]);

  useEffect(() => setSelected(0), [query, root]);

  const q = query.trim();
  const groups = useMemo(() => (result === null ? [] : groupHits(result.hits)), [result]);
  const flat = useMemo(
    () => groups.flatMap((g) => g.hits.map((h) => ({ path: h.path, line: h.line, text: h.text }))),
    [groups],
  );
  const groupStarts = useMemo(() => {
    let acc = 0;
    return groups.map((g) => {
      const start = acc;
      acc += g.hits.length;
      return start;
    });
  }, [groups]);
  const active = Math.min(selected, Math.max(flat.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, flat.length]);

  const move = (delta: number): void => {
    if (flat.length === 0) return;
    setSelected((prev) => Math.min(Math.max(prev + delta, 0), flat.length - 1));
  };

  const openActive = (): void => {
    const row = flat[active];
    if (row) onOpen(row.path, row.line);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      openActive();
    }
  };

  return (
    <div className="search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="search-panel" role="dialog" aria-label="project search">
        <div className="search-inputrow">
          <input
            className="search-input"
            autoFocus
            value={query}
            placeholder="search across the project"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="search-count">
            {loading ? '…' : result !== null && result.hits.length > 0 ? `${result.hits.length}${result.truncated ? '+' : ''}` : ''}
          </span>
          {result !== null && result.hits.length > 0 && <span className="search-engine">{result.engine}</span>}
          <button type="button" className="btn btn-sm search-close" onClick={onClose}>
            close
          </button>
        </div>
        {error !== null ? (
          <div className="search-empty">{error}</div>
        ) : q.length === 0 ? (
          <div className="search-empty">type to search across the project</div>
        ) : flat.length === 0 && !loading ? (
          <div className="search-empty">no matches</div>
        ) : (
          <div className="search-results" ref={listRef}>
            {groups.map((g, gi) => (
              <div key={g.path} className="search-group">
                <div className="search-group-path" title={g.path}>
                  {relativePath(g.path, root)}
                </div>
                {g.hits.map((h, hi) => {
                  const idx = groupStarts[gi]! + hi;
                  const isActive = idx === active;
                  return (
                    <button
                      type="button"
                      key={`${h.line}:${h.text}`}
                      className={`search-row${isActive ? ' search-row-active' : ''}`}
                      data-active={isActive || undefined}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => onOpen(h.path, h.line)}
                    >
                      <span className="search-line">{h.line}</span>
                      {highlight(h.text.trim(), q)}
                    </button>
                  );
                })}
              </div>
            ))}
            {result !== null && result.truncated && (
              <div className="search-truncated">results truncated — refine the query</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
