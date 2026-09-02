import { useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { ADVANCED_KNOBS, draftFromKnobs, knobsFromDraft, type KnobAdapter, type KnobDraft } from './knobs.js';

export interface SamplingSectionProps {
  settings: Settings;
  /** The resolved adapter from the Model section — filters which knobs apply. */
  adapter: string;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
}

/** Settings▸Sampling & Context — the model-tuning knobs. Unset fields are
 *  not sent on the wire; the settings whitelist drops out-of-range values
 *  at load (never coerces). */
export function SamplingSection(props: SamplingSectionProps): React.JSX.Element {
  const { settings, adapter, onSaved, onNotice } = props;
  const [draft, setDraft] = useState<KnobDraft>(draftFromKnobs(settings.reviewer.knobs));
  const [saving, setSaving] = useState(false);

  const visible = ADVANCED_KNOBS.filter((f) => f.adapters.includes(adapter as KnobAdapter));

  const save = (): void => {
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: { ...settings.reviewer, knobs: knobsFromDraft(draft) },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        onNotice('sampling saved — restart the reviewer to apply');
      })
      .catch(() => onNotice('failed to save sampling'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        Model-tuning knobs for the resolved adapter (<span className="settings-mono">{adapter}</span>). Empty = provider default,
        nothing sent on the wire.
      </p>
      <div className="settings-knob-grid">
        {visible.map((f) => (
          <label key={f.key} className="settings-field">
            {f.label}
            {f.kind === 'select' ? (
              <select value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                {f.options?.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.kind === 'number' ? 'number' : 'text'}
                inputMode={f.kind === 'number' ? 'decimal' : undefined}
                value={draft[f.key]}
                placeholder={f.placeholder ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                autoComplete="off"
              />
            )}
            {f.hint && <span className="settings-hint">{f.hint}</span>}
          </label>
        ))}
        {visible.length === 0 && <p className="settings-lede">no knobs for this adapter — pick a provider in the Model section.</p>}
      </div>
      <div className="settings-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
          {saving ? 'saving…' : 'save'}
        </button>
      </div>
    </div>
  );
}
