import { useEffect, useState } from 'react';
import { bridge, type Settings } from '../../ipc.js';
import { deriveLoopCadence, POLL_SECONDS_MAX, POLL_SECONDS_MIN } from '../../shared/loop-cadence.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';

export interface LoopSectionProps {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Named hunger presets — the stored value is always one number
 *  (reviewer.pollSeconds); presets are a UI affordance over it. */
const PRESETS: Array<{ seconds: number; label: string; blurb: string }> = [
  { seconds: 90, label: 'lazy', blurb: '90s — a quiet background pulse' },
  { seconds: 45, label: 'calm', blurb: '45s — half-speed oversight' },
  { seconds: 15, label: 'standard', blurb: '15s — the default cadence' },
];

function parseSeconds(raw: string): number | undefined {
  const t = raw.trim();
  if (t.length === 0) return undefined;
  const v = Number(t);
  return Number.isInteger(v) ? v : NaN;
}

/** Settings▸Loop — the loop carrier's hunger: how often the ledger re-polls
 *  the tiles and re-checks an armed goal. The backstop and stall guard
 *  scale with the poll rate (wall-time anchored, see loop-cadence.ts) and
 *  the change applies LIVE to a running reviewer — no restart. */
export function LoopSection(props: LoopSectionProps): React.JSX.Element {
  const { settings, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty<string>(
    settings.reviewer.pollSeconds === undefined ? '15' : String(settings.reviewer.pollSeconds),
  );
  const { saved, flash } = useSavedFlash();
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const parsed = parseSeconds(draft);
  const error =
    touched || dirty
      ? Number.isNaN(parsed)
        ? 'seconds must be a whole number'
        : parsed !== undefined && (parsed < POLL_SECONDS_MIN || parsed > POLL_SECONDS_MAX)
          ? `must be between ${POLL_SECONDS_MIN} and ${POLL_SECONDS_MAX} seconds`
          : undefined
      : undefined;

  const effective = deriveLoopCadence(parsed !== undefined && !Number.isNaN(parsed) ? parsed : undefined);
  const activePreset = PRESETS.find((p) => p.seconds === effective.pollIntervalMs / 1000 && (parsed === undefined || parsed === p.seconds));

  const save = (): void => {
    setTouched(true);
    if (error !== undefined) {
      onNotice('fix the poll rate — it must be 2–600 whole seconds');
      return;
    }
    setSaving(true);
    const seconds = parsed ?? 15;
    const next: Settings = { ...settings, reviewer: { ...settings.reviewer, pollSeconds: seconds } };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved(String(seconds));
        flash();
        onNotice('loop cadence saved — applies immediately to a running reviewer');
      })
      .catch(() => onNotice('failed to save the loop cadence'))
      .finally(() => setSaving(false));
  };

  const backstopWall = Math.round((effective.recheckPolls * effective.pollIntervalMs) / 1000);
  const staleWall = Math.round((effective.staleWakeLimit * effective.pollIntervalMs) / 1000);

  return (
    <div className="settings-section">
      <p className="settings-lede">
        How hungry the loop master is: the rate at which the ledger re-polls agent tiles and re-checks an armed goal. The re-check
        backstop and stall stand-down scale with it — wall-time anchored, so hunger changes the pace, not the guards' meaning.
      </p>
      <SectionCard title="Loop hunger" hint="Applies immediately to a running reviewer — no restart needed.">
        <div className="settings-preset-row" role="radiogroup" aria-label="loop hunger preset">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={activePreset?.label === p.label}
              className={`settings-preset${activePreset?.label === p.label ? ' settings-preset-active' : ''}`}
              title={p.blurb}
              onClick={() => {
                setTouched(false);
                setDraft(() => String(p.seconds));
              }}
            >
              <span className="settings-preset-label">{p.label}</span>
              <span className="settings-preset-seconds">{p.seconds}s</span>
            </button>
          ))}
        </div>
        <Field
          label="custom poll rate (seconds)"
          htmlFor="settings-poll-seconds"
          hint={`whole seconds, ${POLL_SECONDS_MIN}–${POLL_SECONDS_MAX} · the presets above just fill this in`}
          error={error}
        >
          <input
            id="settings-poll-seconds"
            type="number"
            inputMode="numeric"
            className="settings-input"
            value={draft}
            placeholder="15"
            min={POLL_SECONDS_MIN}
            max={POLL_SECONDS_MAX}
            step={1}
            aria-invalid={error !== undefined ? true : undefined}
            onChange={(e) => {
              setTouched(true);
              setDraft(() => e.target.value);
            }}
            autoComplete="off"
          />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={saving || error !== undefined} onClick={save}>
            {saving ? 'saving…' : saved ? 'saved' : 'save'}
          </button>
        </div>
      </SectionCard>
      <SectionCard title="Effective cadence" hint="What the loop carrier will actually do at this rate.">
        <div className="settings-kv">
          <span>poll rate</span>
          <span className="settings-mono">every {effective.pollIntervalMs / 1000}s</span>
          <span>re-check backstop</span>
          <span className="settings-mono">
            {effective.recheckPolls} silent poll{effective.recheckPolls === 1 ? '' : 's'} ≈ {backstopWall}s
          </span>
          <span>stall stand-down</span>
          <span className="settings-mono">
            {effective.staleWakeLimit} ledger-less wake{effective.staleWakeLimit === 1 ? '' : 's'} ≈ {staleWall}s
          </span>
        </div>
        <span className="settings-hint">
          The backstop forces a goal re-check after that much silence; the stall guard stands the re-check loop down after that many
          wakes that changed nothing in the ledger.
        </span>
      </SectionCard>
    </div>
  );
}
