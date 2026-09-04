import { useEffect, useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { CUSTOM_PLACEHOLDER } from '../../shared/autonomy.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';

export interface ComposeSectionProps {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface ComposeDraft {
  name: string;
  prompt: string;
}

/** Settings▸Auto Compose — the user's custom autonomous loop: a name shown
 *  in the auto compose popover and the full AUTONOMOUS MODE directive
 *  appended to the reviewer's system prompt when the custom loop starts. */
export function ComposeSection(props: ComposeSectionProps): React.JSX.Element {
  const { settings, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty<ComposeDraft>({
    name: settings.reviewer.customAutonomy?.name ?? '',
    prompt: settings.reviewer.customAutonomy?.prompt ?? '',
  });
  const { saved, flash } = useSavedFlash();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const save = (): void => {
    if (draft.prompt.trim().length === 0) return;
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: {
        ...settings.reviewer,
        customAutonomy: { name: draft.name.trim().length > 0 ? draft.name.trim() : undefined, prompt: draft.prompt },
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved({ name: draft.name.trim().length > 0 ? draft.name.trim() : '', prompt: draft.prompt });
        flash();
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
      <SectionCard title="Custom autonomy">
        <Field label="loop name" htmlFor="settings-compose-name" hint="shown in the auto compose popover">
          <input
            id="settings-compose-name"
            className="settings-input"
            maxLength={40}
            value={draft.name}
            placeholder="shown in the auto compose popover"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            autoComplete="off"
          />
        </Field>
        <Field label="directive" htmlFor="settings-compose-directive" wide>
          <textarea
            id="settings-compose-directive"
            className="settings-textarea"
            rows={14}
            maxLength={4000}
            value={draft.prompt}
            placeholder="the AUTONOMOUS MODE directive appended to the reviewer's system prompt when this loop starts…"
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          />
        </Field>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving || draft.prompt.trim().length === 0}
            onClick={save}
          >
            {saving ? 'saving…' : saved ? 'saved' : 'save'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title="restore the built-in placeholder directive"
            onClick={() => setDraft((d) => ({ ...d, prompt: CUSTOM_PLACEHOLDER }))}
          >
            reset placeholder
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
