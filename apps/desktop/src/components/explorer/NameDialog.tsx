import React, { useState } from 'react';
import { Dialog } from '../Dialog.js';

export interface NameDialogProps {
  title: string;
  confirmLabel: string;
  initial: string;
  placeholder?: string;
  /** Resolves an inline error message, or null on success (closes). */
  onSubmit(name: string): Promise<string | null>;
  onCancel(): void;
}

/** New-file / new-folder / rename prompt with inline validation: Enter
 *  confirms, Escape cancels (through the shared Dialog), duplicate or
 *  invalid names surface as an inline error line. */
export function NameDialog(props: NameDialogProps): React.JSX.Element {
  const { title, confirmLabel, initial, placeholder, onSubmit, onCancel } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (): void => {
    const name = value.trim();
    if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      setError('invalid name');
      return;
    }
    if (busy) return;
    setBusy(true);
    void onSubmit(name).then((err) => {
      if (err === null) {
        onCancel();
        return;
      }
      setBusy(false);
      setError(err);
    });
  };

  return (
    <Dialog title={title} onClose={onCancel} accent="explorer" size="sm">
      <input
        className="dialog-input"
        autoFocus
        value={value}
        placeholder={placeholder ?? 'name'}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error !== null && <div className="explorer-form-error">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || value.trim().length === 0}
          onClick={submit}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
