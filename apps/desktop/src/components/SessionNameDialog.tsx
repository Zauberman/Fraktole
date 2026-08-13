import React, { useState } from 'react';

export interface SessionNameDialogProps {
  title: string;
  initial: string;
  confirmLabel: string;
  placeholder?: string;
  onConfirm(name: string): void;
  onCancel(): void;
}

/** Small in-app name dialog for session new/rename/save-as — the
 *  orchestrator panel that used to own these flows is gone; the native
 *  Session menu forwards here. */
export function SessionNameDialog(props: SessionNameDialogProps): React.JSX.Element {
  const { title, initial, confirmLabel, placeholder, onConfirm, onCancel } = props;
  const [value, setValue] = useState(initial);
  const confirm = (): void => {
    const name = value.trim();
    if (name.length === 0) return;
    onConfirm(name);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        <input
          className="dialog-input"
          autoFocus
          value={value}
          placeholder={placeholder ?? 'session name'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={value.trim().length === 0} onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
