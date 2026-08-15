import React, { useState } from 'react';
import { CUSTOM_PLACEHOLDER } from '../shared/autonomy.js';

export interface CustomPluginDialogProps {
  initial: { name: string; prompt: string };
  onSave(name: string, prompt: string): void;
  onCancel(): void;
}

/** Editor for the user's custom autonomous loop: a name (shown in the
 *  popover) and the full AUTONOMOUS MODE directive appended to the
 *  reviewer's system prompt. Saved to settings (reviewer.customAutonomy). */
export function CustomPluginDialog(props: CustomPluginDialogProps): React.JSX.Element {
  const { initial, onSave, onCancel } = props;
  const [name, setName] = useState(initial.name);
  const [prompt, setPrompt] = useState(initial.prompt);
  const save = (): void => {
    if (prompt.trim().length === 0) return;
    onSave(name.trim(), prompt);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog dialog-wide">
        <div className="dialog-title">custom autonomous loop</div>
        <input
          className="dialog-input"
          autoFocus
          maxLength={40}
          value={name}
          placeholder="loop name (shown in the auto compose popover)"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        />
        <textarea
          className="dialog-textarea"
          rows={14}
          maxLength={4000}
          value={prompt}
          placeholder="the AUTONOMOUS MODE directive appended to the reviewer's system prompt when this loop starts…"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            cancel
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title="restore the built-in placeholder directive"
            onClick={() => setPrompt(CUSTOM_PLACEHOLDER)}
          >
            reset placeholder
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={prompt.trim().length === 0} onClick={save}>
            save
          </button>
        </div>
      </div>
    </div>
  );
}
