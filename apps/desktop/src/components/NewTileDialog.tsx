import React, { useEffect, useRef, useState } from 'react';
import type { Project } from '../ipc.js';
import { Dialog } from './Dialog.js';

interface NewTileDialogProps {
  projects: Project[];
  defaultPath: string;
  onConfirm(path: string): void;
  onCancel(): void;
}

/** The tile launcher: a command-line row backed by a card grid of known
 *  projects (explorer-tinted). Enter confirms, Esc cancels via Dialog. */
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
    <Dialog title="open terminal at" onClose={onCancel} accent="explorer" size="md" footer={
      <>
        <span className="dialog-hint">enter opens · esc cancels</span>
        <button type="button" className="btn btn-primary" onClick={submit}>
          open
        </button>
      </>
    }>
      <div className="launcher-input-line">
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      {projects.length > 0 && (
        <ul className="launcher-grid">
          {projects.slice(0, 6).map((p) => (
            <li key={p.path}>
              <button type="button" className="launcher-card" onMouseDown={() => onConfirm(p.path)}>
                <span className="launcher-card-name">{p.name}</span>
                <span className="launcher-card-path">{p.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
