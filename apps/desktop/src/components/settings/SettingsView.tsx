import { useEffect, useState } from 'react';
import { bridge, type AppInfo, type Settings, type SettingsSection } from '../../ipc.js';
import { GeneralSection } from './GeneralSection.js';
import { ModelSection } from './ModelSection.js';
import { SamplingSection } from './SamplingSection.js';
import { AgentsSection } from './AgentsSection.js';
import { ComposeSection } from './ComposeSection.js';
import { EditorPrefsSection } from './EditorPrefsSection.js';
import { ShortcutsSection } from './ShortcutsSection.js';
import { UsageSection } from './UsageSection.js';
import { resolveReviewerConfig } from '../../shared/reviewer-detect.js';

export interface SettingsViewProps {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onTheme: (id: string) => void;
  themeId: string;
  /** The active session, when a reviewer restart target exists. */
  sessionId: string | null;
  onNotice: (message: string) => void;
}

const NAV: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'model', label: 'Model' },
  { id: 'sampling', label: 'Sampling & Context' },
  { id: 'agents', label: 'Agents & Launchers' },
  { id: 'compose', label: 'Auto Compose' },
  { id: 'editor', label: 'Editor' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'usage', label: 'Usage' },
  { id: 'advanced', label: 'Advanced' },
];

/** The in-app Settings Center: a full-window ledger with a section sidebar.
 *  One themed surface instead of a modal that outgrew the viewport; the
 *  native Settings menu and the command palette jump straight to sections. */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const { section, onSection, onClose, onTheme, themeId, sessionId, onNotice } = props;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void bridge.getSettings().then((s) => alive && setSettings(s));
    void bridge.getAppInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="settings-view" role="dialog" aria-label="settings">
      <header className="settings-header">
        <span className="pane-title">Settings</span>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="close settings">
          close
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="settings sections">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`settings-nav-item${n.id === section ? ' settings-nav-item-active' : ''}`}
              onClick={() => onSection(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" key={section}>
          {!settings ? (
            <p className="settings-lede">loading…</p>
          ) : section === 'general' ? (
            <GeneralSection settings={settings} themeId={themeId} onTheme={onTheme} onSaved={setSettings} onNotice={onNotice} />
          ) : section === 'model' ? (
            <ModelSection settings={settings} sessionId={sessionId} onSaved={setSettings} onNotice={onNotice} />
          ) : section === 'sampling' ? (
            <SamplingSection
              settings={settings}
              adapter={
                resolveReviewerConfig({
                  apiKey: settings.reviewer.apiKey,
                  providerId: settings.reviewer.providerId,
                  provider: settings.reviewer.provider,
                  model: settings.reviewer.model,
                  baseUrl: settings.reviewer.baseUrl,
                }).adapter
              }
              onSaved={setSettings}
              onNotice={onNotice}
            />
          ) : section === 'agents' ? (
            <AgentsSection settings={settings} sessionId={sessionId} onSaved={setSettings} onNotice={onNotice} />
          ) : section === 'compose' ? (
            <ComposeSection settings={settings} onSaved={setSettings} onNotice={onNotice} />
          ) : section === 'editor' ? (
            <EditorPrefsSection onNotice={onNotice} />
          ) : section === 'shortcuts' ? (
            <ShortcutsSection />
          ) : section === 'usage' ? (
            <UsageSection />
          ) : (
            <AdvancedSection info={info} />
          )}
        </div>
      </div>
    </div>
  );
}

function AdvancedSection(props: { info: AppInfo | null }): React.JSX.Element {
  const { info } = props;
  return (
    <div className="settings-section">
      <p className="settings-lede">App internals and data location.</p>
      <div className="settings-field settings-field-wide">
        app
        <div className="settings-kv">
          <span>version</span>
          <span className="settings-mono">{info?.version ?? '…'}</span>
          <span>shell</span>
          <span className="settings-mono">{info?.shell ?? '…'}</span>
          <span>data directory</span>
          <span className="settings-mono">{info?.userData ?? '…'}</span>
        </div>
      </div>
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void bridge.revealDataDir().catch(() => undefined)}
        >
          reveal data directory
        </button>
      </div>
      <p className="settings-lede">
        Settings persist in <span className="settings-mono">settings.json</span>; per-session reviewer state in the session&apos;s{' '}
        <span className="settings-mono">reviewer/</span> directory. Deleting a file there resets that part only.
      </p>
    </div>
  );
}
