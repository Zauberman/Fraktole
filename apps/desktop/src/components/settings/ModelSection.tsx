import { useEffect, useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import {
  DEFAULT_MODELS,
  REVIEWER_MODEL_SUGGESTIONS,
  resolveReviewerConfig,
  type DetectedProvider,
} from '../../shared/reviewer-detect.js';
import { PROVIDER_GROUPS, getProvider, requiresKey, type ProviderCatalogEntry } from '../../shared/provider-catalog.js';
import { skHint } from './sk-hint.js';

export interface ModelSectionProps {
  settings: Settings;
  sessionId: string | null;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
}

/** Settings▸Model — the reviewer harness's provider config, moved out of
 *  the old inline config modal. Saves the reviewer slice (minus knobs,
 *  launchers and the custom loop, which own sections) and offers an
 *  explicit reviewer restart instead of an implicit "save & restart". */
export function ModelSection(props: ModelSectionProps): React.JSX.Element {
  const { settings, sessionId, onSaved, onNotice } = props;
  const [apiKey, setApiKey] = useState(settings.reviewer.apiKey ?? '');
  const [providerId, setProviderId] = useState(settings.reviewer.providerId ?? '');
  const [model, setModel] = useState(settings.reviewer.model ?? '');
  const [baseUrl, setBaseUrl] = useState(settings.reviewer.baseUrl ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(settings.reviewer.reasoningEffort ?? '');
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  const config = resolveReviewerConfig({
    apiKey,
    providerId: providerId || undefined,
    model,
    baseUrl,
  });
  const selEntry = getProvider(providerId || undefined);
  const keyRequired = requiresKey(config.entry);
  const derived: DetectedProvider =
    config.entry?.adapter ?? (config.adapter === 'openai' && config.baseUrl.includes('deepseek') ? 'deepseek' : config.adapter);
  const suggestions = liveModels ?? selEntry?.models ?? REVIEWER_MODEL_SUGGESTIONS[derived] ?? [];

  const q = filter.trim().toLowerCase();
  const filteredGroups = q
    ? PROVIDER_GROUPS.map((g) => ({
        ...g,
        entries: g.entries.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
      }))
    : PROVIDER_GROUPS;

  // live model list (debounced) — same policy as the old modal: keyless
  // local servers fetch too, a key-demanded entry with no key stays offline
  useEffect(() => {
    const key = apiKey.trim();
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
  }, [apiKey, baseUrl, providerId, config.baseUrl, config.adapter, config.entry?.auth]);

  const applyProviderDefaults = (entry: ProviderCatalogEntry): void => {
    setProviderId(entry.id);
    setBaseUrl((b) => (b.trim().length === 0 ? entry.baseUrl : b));
    setModel((m) => (m.trim().length === 0 ? entry.defaultModel : m));
  };

  const save = (): void => {
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: {
        ...settings.reviewer,
        apiKey: apiKey.trim() || undefined,
        providerId: providerId || undefined,
        model: model.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        reasoningEffort: (reasoningEffort || undefined) as Settings['reviewer']['reasoningEffort'],
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
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
      <label className="settings-field settings-field-wide">
        provider
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="search providers…"
          autoComplete="off"
        />
        <select
          value={providerId}
          onChange={(e) => {
            setFilter('');
            const entry = getProvider(e.target.value || undefined);
            if (entry) applyProviderDefaults(entry);
            else setProviderId('');
          }}
        >
          <option value="">{filter.trim() ? 'matched provider…' : 'auto-detect from the key'}</option>
          {filteredGroups.map((g) =>
            g.entries.length > 0 ? (
              <optgroup key={g.group} label={`${g.label} (${g.entries.length})`}>
                {g.entries.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        {selEntry?.notes && <span className="settings-hint">{selEntry.notes}</span>}
      </label>
      <label className="settings-field settings-field-wide">
        api key{keyRequired ? '' : ' (optional / none for local)'}
        <input
          type="password"
          value={apiKey}
          disabled={config.entry?.auth === 'none'}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={selEntry?.keyHint ?? skHint(apiKey)}
          autoComplete="off"
        />
      </label>
      <div className="settings-row">
        <label className="settings-field">
          model
          <input list="settings-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODELS[derived]} />
          <datalist id="settings-models">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="settings-field">
          baseUrl (optional)
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selEntry?.baseUrl || '(provider default)'} />
        </label>
      </div>
      <label className="settings-field settings-field-narrow">
        reasoning effort
        <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)}>
          <option value="">auto (high on deepseek/openai)</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </label>
      <div className="settings-badge-row">
        <span className="orch-judge-status orch-judge-running">{derived}</span>
        {config.model && <span className="reviewer-model-label">{config.model}</span>}
        {apiKey.trim().length === 0 && keyRequired && <span className="reviewer-model-label">paste an api key to enable</span>}
      </div>
      <div className="settings-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
          {saving ? 'saving…' : 'save'}
        </button>
        {sessionId && (
          <button
            type="button"
            className="btn btn-sm"
            title="the running reviewer picks this up on its next start"
            onClick={() => {
              void bridge.restartReviewer(sessionId).then(() => onNotice('reviewer restarted'));
            }}
          >
            restart reviewer now
          </button>
        )}
      </div>
    </div>
  );
}
