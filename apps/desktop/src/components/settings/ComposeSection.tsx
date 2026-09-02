import { useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { CUSTOM_PLACEHOLDER } from '../../shared/autonomy.js';

export interface ComposeSectionProps {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
}

/** Settings▸Auto Compose — the user's custom autonomous loop: a name shown
 *  in the auto compose popover and the full AUTONOMOUS MODE directive
 *  appended to the reviewer's system prompt when the custom loop starts. */
export function ComposeSection(props: ComposeSectionProps): React.JSX.Element {
  const { settings, onSaved, onNotice } = props;
  const [name, setName] = useState(settings.reviewer.customAutonomy?.name ?? '');
  const [prompt, setPrompt] = useState(settings.reviewer.customAutonomy?.prompt ?? '');
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    if (prompt.trim().length === 0) return;
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: {
        ...settings.reviewer,
        customAutonomy: { name: name.trim().length > 0 ? name.trim() : undefined, prompt },
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        onNotice('custom loop saved — applied on the next loop start');
      })
      .catch(() => onNotice('failed to save the custom loop'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        The custom Auto Compose loop. The directive replaces the placeholder whenever the custom variant is picked in the auto
        compose popover; it takes effect on the next loop start — no reviewer restart needed.
      </p>
      <label className="settings-field settings-field-wide">
        loop name
        <input
          maxLength={40}
          value={name}
          placeholder="shown in the auto compose popover"
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="settings-field settings-field-wide">
        directive
        <textarea
          className="settings-textarea"
          rows={14}
          maxLength={4000}
          value={prompt}
          placeholder="the AUTONOMOUS MODE directive appended to the reviewer's system prompt when this loop starts…"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving || prompt.trim().length === 0} onClick={save}>
          {saving ? 'saving…' : 'save'}
        </button>
        <button type="button" className="btn btn-sm" title="restore the built-in placeholder directive" onClick={() => setPrompt(CUSTOM_PLACEHOLDER)}>
          reset placeholder
        </button>
      </div>
    </div>
  );
}
