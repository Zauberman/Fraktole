import { useEffect, useState } from 'react';
import { Select, type SelectOption } from '../Select.js';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import {
  DEFAULT_MODELS,
  REVIEWER_MODEL_SUGGESTIONS,
  resolveReviewerConfig,
  type DetectedProvider,
} from '../../shared/reviewer-detect.js';
import { PROVIDER_GROUPS, getProvider, requiresKey, type ProviderCatalogEntry } from '../../shared/provider-catalog.js';
import { Field, SectionCard } from './fields.js';
import { useDirty, useSavedFlash } from './use-dirty.js';
import { useReviewerHealth } from './use-reviewer-health.js';
import { skHint } from './sk-hint.js';

export interface ModelSectionProps {
  settings: Settings;
  sessionId: string | null;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Draft shape for the reviewer slice this section owns (knobs, launchers
 *  and the custom loop live in their own sections). */
interface ModelDraft {
  apiKey: string;
  providerId: string;
  model: string;
  baseUrl: string;
  reasoningEffort: string;
}

/** Settings▸Model — the reviewer harness's provider config, moved out of
 *  the old inline config modal. Saves the reviewer slice (minus knobs,
 *  launchers and the custom loop, which own sections) and offers an
 *  explicit reviewer restart instead of an implicit "save & restart". */
export function ModelSection(props: ModelSectionProps): React.JSX.Element {
  const { settings, sessionId, onSaved, onNotice, onDirtyChange } = props;
  const { draft, setDraft, dirty, markSaved } = useDirty<ModelDraft>({
    apiKey: settings.reviewer.apiKey ?? '',
    providerId: settings.reviewer.providerId ?? '',
    model: settings.reviewer.model ?? '',
    baseUrl: settings.reviewer.baseUrl ?? '',
    reasoningEffort: settings.reviewer.reasoningEffort ?? '',
  });
  const { saved, flash } = useSavedFlash();
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty]);

  const config = resolveReviewerConfig({
    apiKey: draft.apiKey,
    providerId: draft.providerId || undefined,
    model: draft.model,
    baseUrl: draft.baseUrl,
  });
  const selEntry = getProvider(draft.providerId || undefined);
  const keyRequired = requiresKey(config.entry);
  const derived: DetectedProvider =
    config.entry?.adapter ?? (config.adapter === 'openai' && config.baseUrl.includes('deepseek') ? 'deepseek' : config.adapter);

  const q = filter.trim().toLowerCase();
  const filteredGroups = q
    ? PROVIDER_GROUPS.map((g) => ({
        ...g,
        entries: g.entries.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
      }))
    : PROVIDER_GROUPS;

  const providerOptions: SelectOption[] = [
    { value: '', label: filter.trim() ? 'matched provider…' : 'auto-detect from the key' },
    ...filteredGroups.flatMap((g) =>
      g.entries.map((p) => ({ value: p.id, label: p.name, section: `${g.label} (${g.entries.length})` })),
    ),
  ];

  // live model list (debounced) — same policy as the old modal: keyless
  // local servers fetch too, a key-demanded entry with no key stays offline.
  // Cloud entries with a live health panel get their models from the probe
  // instead (one poller, not two).
  const healthEnabled =
    config.adapter === 'ollama' || selEntry?.group === 'local' || (selEntry?.group === 'custom' && draft.baseUrl.trim().length > 0);
  const health = useReviewerHealth(
    {
      adapter: config.adapter as 'openai' | 'anthropic' | 'ollama',
      apiKey: draft.apiKey.trim(),
      baseUrl: config.baseUrl,
      model: config.model ?? draft.model,
    },
    healthEnabled,
  );
  useEffect(() => {
    if (healthEnabled) return;
    const key = draft.apiKey.trim();
    if (config.entry?.auth === 'key' && key.length === 0) {
      setLiveModels(null);
      return;
    }
    const adapter = config.adapter;
    const timer = window.setTimeout(() => {
      void bridge
        .listReviewerModels({ adapter, apiKey: key, baseUrl: config.baseUrl })
        .then((models) => setLiveModels(models.length > 0 ? models : null))
        .catch(() => setLiveModels(null));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [healthEnabled, draft.apiKey, draft.baseUrl, draft.providerId, config.baseUrl, config.adapter, config.entry?.auth]);

  const probedModels = healthEnabled && health.result !== null && health.result.models.length > 0 ? health.result.models : null;
  const suggestions = probedModels ?? liveModels ?? selEntry?.models ?? REVIEWER_MODEL_SUGGESTIONS[derived] ?? [];

  const applyProviderDefaults = (entry: ProviderCatalogEntry): void => {
    setDraft((d) => ({
      ...d,
      providerId: entry.id,
      baseUrl: d.baseUrl.trim().length === 0 ? entry.baseUrl : d.baseUrl,
      model: d.model.trim().length === 0 ? entry.defaultModel : d.model,
    }));
  };

  const save = (): void => {
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: {
        ...settings.reviewer,
        apiKey: draft.apiKey.trim() || undefined,
        providerId: draft.providerId || undefined,
        model: draft.model.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || undefined,
        reasoningEffort: (draft.reasoningEffort || undefined) as Settings['reviewer']['reasoningEffort'],
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        markSaved({
          apiKey: draft.apiKey.trim(),
          providerId: draft.providerId,
          model: draft.model.trim(),
          baseUrl: draft.baseUrl.trim(),
          reasoningEffort: draft.reasoningEffort,
        });
        flash();
        onNotice('model config saved — restart the reviewer to apply');
      })
      .catch(() => onNotice('failed to save the model config'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        The reviewer model harness: provider, key, model and endpoint. Agents, launchers and sampling live in their own sections.
      </p>
      <SectionCard title="Provider">
        <Field label="provider">
          <input
            id="settings-provider-search"
            type="text"
            className="settings-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="search providers…"
            aria-label="search providers"
            autoComplete="off"
          />
          <Select
            ariaLabel="provider"
            value={draft.providerId}
            placeholder={filter.trim() ? 'matched provider…' : 'auto-detect from the key'}
            onChange={(v) => {
              setFilter('');
              const entry = getProvider(v || undefined);
              if (entry) applyProviderDefaults(entry);
              else setDraft((d) => ({ ...d, providerId: '' }));
            }}
            options={providerOptions}
          />
          {selEntry?.notes && <span className="settings-hint">{selEntry.notes}</span>}
        </Field>
        <Field
          label={`api key${keyRequired ? '' : ' (optional / none for local)'}`}
          htmlFor="settings-api-key"
        >
          <input
            id="settings-api-key"
            type="password"
            className="settings-input"
            value={draft.apiKey}
            disabled={config.entry?.auth === 'none'}
            onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
            placeholder={selEntry?.keyHint ?? skHint(draft.apiKey)}
            autoComplete="off"
          />
        </Field>
      </SectionCard>
      <SectionCard title="Model identity">
        <div className="settings-row">
          <Field label="model" htmlFor="settings-model">
            <input
              id="settings-model"
              className="settings-input"
              list="settings-models"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder={DEFAULT_MODELS[derived]}
              autoComplete="off"
            />
            <datalist id="settings-models">
              {suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="baseUrl (optional)" htmlFor="settings-baseurl">
            <input
              id="settings-baseurl"
              className="settings-input"
              value={draft.baseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              placeholder={selEntry?.baseUrl || '(provider default)'}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="settings-badge-row">
          <span className="orch-judge-status orch-judge-running">{derived}</span>
          {config.model && <span className="reviewer-model-label">{config.model}</span>}
          {draft.apiKey.trim().length === 0 && keyRequired && <span className="reviewer-model-label">paste an api key to enable</span>}
        </div>
      </SectionCard>
      {healthEnabled && (
        <SectionCard
          title="Local server health"
          hint="Live probe of the configured endpoint — refreshes every few seconds and on save."
        >
          <div className="settings-badge-row">
            <span className={`settings-probe settings-probe-${health.result?.state ?? 'unknown'}`}>
              {health.result === null ? 'probing…' : health.result.state}
            </span>
            {health.result?.serverContext !== undefined && (
              <span className="reviewer-model-label">context window {health.result.serverContext}</span>
            )}
            {probedModels !== null && <span className="reviewer-model-label">{probedModels.length} models live</span>}
          </div>
          {health.result?.detail && <span className="settings-hint">{health.result.detail}</span>}
        </SectionCard>
      )}
      <SectionCard title="Reasoning">
        <Field label="reasoning effort">
          <Select
            ariaLabel="reasoning effort"
            value={draft.reasoningEffort}
            onChange={(v) => setDraft((d) => ({ ...d, reasoningEffort: v }))}
            options={[
              { value: '', label: 'auto', hint: 'high on deepseek/openai' },
              { value: 'high', label: 'high' },
              { value: 'medium', label: 'medium' },
              { value: 'low', label: 'low' },
            ]}
          />
        </Field>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
            {saving ? 'saving…' : saved ? 'saved' : 'save'}
          </button>
          {sessionId && (
            <button
              type="button"
              className="btn btn-sm"
              title="the running reviewer picks this up on its next start"
              onClick={() => {
                void bridge.restartReviewer(sessionId)
                  .then((ok) => onNotice(ok ? 'reviewer restarted' : 'reviewer not running — nothing to restart'))
                  .catch(() => onNotice('restart failed'));
              }}
            >
              restart reviewer now
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
