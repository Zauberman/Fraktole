import React, { useState } from 'react';
import { Dialog } from './Dialog.js';

export interface SessionNameDialogProps {
  title: string;
  initial: string;
  confirmLabel: string;
  placeholder?: string;
  onConfirm(name: string): void;
  onCancel(): void;
}

/** Session new/rename/save-as — a namer plate: the typed name previews
 *  large in the display serif above the field, so the identity being
 *  created is the focal point. */
export function SessionNameDialog(props: SessionNameDialogProps): React.JSX.Element {
  const { title, initial, confirmLabel, placeholder, onConfirm, onCancel } = props;
  const [value, setValue] = useState(initial);
  const confirm = (): void => {
    const name = value.trim();
    if (name.length === 0) return;
    onConfirm(name);
  };
  return (
    <Dialog title={title} onClose={onCancel} accent="reviewer" size="sm" footer={
      <>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={value.trim().length === 0} onClick={confirm}>
          {confirmLabel}
        </button>
      </>
    }>
      <div className="name-preview" aria-hidden="true">
        {value.trim().length > 0 ? value : (placeholder ?? 'session name')}
      </div>
      <input
        className="dialog-input"
        autoFocus
        value={value}
        placeholder={placeholder ?? 'session name'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm();
        }}
      />
    </Dialog>
  );
}
