import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, type ProjectFile } from '../ipc.js';

interface QuickOpenProps {
  root: string | null;
  onOpen(path: string): void;
  onCancel(): void;
}

/**
 * Quick-open palette (Ctrl+P): lists every file under the active project
 * root (bounded walk in main), filters by subsequence match as you type,
 * Enter opens the selected file in the editor. Esc closes.
 */
export function QuickOpen(props: QuickOpenProps): React.JSX.Element {
  const { root, onOpen, onCancel } = props;
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
        if (!cancelled) {
          setFiles([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return files;
    // subsequence match on the basename, then on the full path
    const sub = (s: string): boolean => {
      let i = 0;
      const t = s.toLowerCase();
      for (let k = 0; k < t.length && i < q.length; k += 1) {
        if (t[k] === q[i]) i += 1;
      }
      return i === q.length;
    };
    return files.filter((f) => sub(f.name) || sub(f.path));
  }, [files, query]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog dialog-quickopen" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">open file</div>
        <input
          ref={inputRef}
          className="dialog-input"
          value={query}
          placeholder={root ? `find in ${root}` : 'no project root'}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onCancel();
              return;
            }
            if (e.key === 'Enter') {
              const hit = filtered[sel];
              if (hit) onOpen(hit.path);
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
              return;
            }
            e.stopPropagation();
          }}
        />
        <div className="quickopen-count">
          {loading ? 'loading…' : `${filtered.length} file${filtered.length === 1 ? '' : 's'}`}
        </div>
        {filtered.length > 0 && (
          <ul className="quickopen-list">
            {filtered.slice(0, 200).map((f, i) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`quickopen-item${i === sel ? ' quickopen-item-selected' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => onOpen(f.path)}
                >
                  <span className="quickopen-name">{f.name}</span>
                  <span className="quickopen-path">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {filtered.length === 0 && !loading && <div className="quickopen-empty">no matches</div>}
      </div>
    </div>
  );
}
