import React, { useEffect, useRef, useState } from 'react';
import type { Project } from '../ipc.js';

interface NewTileDialogProps {
  projects: Project[];
  defaultPath: string;
  onConfirm(path: string): void;
  onCancel(): void;
}

/**
 * Custom modal for opening a terminal tile: type any absolute path, or
 * quick-pick one of the known projects. Enter confirms, Esc cancels.
 */
export function NewTileDialog(props: NewTileDialogProps): React.JSX.Element {
  const { projects, defaultPath, onConfirm, onCancel } = props;
  const [value, setValue] = useState(defaultPath);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (): void => {
    const path = value.trim();
    if (path.length > 0) onConfirm(path);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">open terminal at</div>
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
            e.stopPropagation();
          }}
        />
        {projects.length > 0 && (
          <ul className="dialog-projects">
            {projects.slice(0, 6).map((p) => (
              <li key={p.path}>
                <button type="button" className="dialog-project" onMouseDown={() => onConfirm(p.path)}>
                  <span className="dialog-project-name">{p.name}</span>
                  <span className="dialog-project-path">{p.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <span className="dialog-hint">enter opens · esc cancels</span>
          <button type="button" className="btn btn-primary" onClick={submit}>
            open
          </button>
        </div>
      </div>
    </div>
  );
}
