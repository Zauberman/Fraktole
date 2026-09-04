import { useEffect, useState } from 'react';
import { Select } from '../Select.js';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';
import {
  ADVANCED_KNOBS,
  KNOB_CARDS,
  draftFromKnobs,
  knobRangeError,
  knobsFromDraft,
  type KnobAdapter,
  type KnobMeta,
} from './knobs.js';

export interface SamplingSectionProps {
  settings: Settings;
  /** The resolved adapter from the Model section — filters which knobs apply. */
  adapter: string;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Settings▸Sampling & Context — the model-tuning knobs, grouped into
 *  cards (context/output, sampler, ollama-only, thinking). Unset fields are
 *  not sent on the wire; out-of-range values are blocked inline instead of
 *  being dropped silently by the settings whitelist. */
export function SamplingSection(props: SamplingSectionProps): React.JSX.Element {
  const { settings, adapter, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty(draftFromKnobs(settings.reviewer.knobs));
  const { saved, flash } = useSavedFlash();
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof typeof draft, boolean>>>({});
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const visible = ADVANCED_KNOBS.filter((f) => f.adapters.includes(adapter as KnobAdapter));

  const errorFor = (f: KnobMeta): string | undefined => knobRangeError(f, draft[f.key]);
  const shownError = (f: KnobMeta): string | undefined =>
    touched[f.key] === true || showErrors ? errorFor(f) : undefined;
  const invalid = visible.some((f) => errorFor(f) !== undefined);

  const save = (): void => {
    if (invalid) {
      setShowErrors(true);
      onNotice('fix the highlighted values — out-of-range knobs would be dropped');
      return;
    }
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: { ...settings.reviewer, knobs: knobsFromDraft(draft) },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved(draftFromKnobs(knobsFromDraft(draft)));
        setShowErrors(false);
        flash();
        onNotice('sampling saved — restart the reviewer to apply');
      })
      .catch(() => onNotice('failed to save sampling'))
      .finally(() => setSaving(false));
  };

  const control = (f: KnobMeta): React.JSX.Element => {
    if (f.kind === 'select') {
      return (
        <Select
          ariaLabel={f.label}
          value={draft[f.key]}
          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
          options={(f.options ?? []).map((o) => ({ value: o.v, label: o.label }))}
        />
      );
    }
    const err = shownError(f);
    return (
      <input
        type={f.kind === 'number' ? 'number' : 'text'}
        inputMode={f.kind === 'number' ? 'decimal' : undefined}
        className="settings-input"
        value={draft[f.key]}
        placeholder={f.placeholder ?? ''}
        min={f.kind === 'number' ? f.min : undefined}
        max={f.kind === 'number' ? f.max : undefined}
        step={f.kind === 'number' ? f.step : undefined}
        aria-invalid={err !== undefined ? true : undefined}
        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
        onBlur={() => setTouched((t) => ({ ...t, [f.key]: true }))}
        autoComplete="off"
      />
    );
  };

  const activeCards = KNOB_CARDS.filter((c) => visible.some((f) => f.card === c.id));

  return (
    <div className="settings-section">
      <p className="settings-lede">
        Model-tuning knobs for the resolved adapter (<span className="settings-mono">{adapter}</span>). Empty = provider default,
        nothing sent on the wire.
      </p>
      {activeCards.length === 0 && (
        <p className="settings-lede">no knobs for this adapter — pick a provider in the Model section.</p>
      )}
      {activeCards.map((card, i) => (
        <SectionCard key={card.id} title={card.title}>
          <div className="settings-knob-grid">
            {visible
              .filter((f) => f.card === card.id)
              .map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint} error={shownError(f)}>
                  {control(f)}
                </Field>
              ))}
          </div>
          {i === activeCards.length - 1 && (
            <div className="settings-actions">
              <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
                {saving ? 'saving…' : saved ? 'saved' : 'save'}
              </button>
            </div>
          )}
        </SectionCard>
      ))}
    </div>
  );
}
