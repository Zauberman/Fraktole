import { useCallback, useEffect, useRef, useState } from 'react';
import { modalClosed, modalOpened } from '../../modal-guard.js';
import { bridge, type AppInfo, type Settings, type SettingsSection } from '../../ipc.js';
import { GeneralSection } from './GeneralSection.js';
import { ModelSection } from './ModelSection.js';
import { SamplingSection } from './SamplingSection.js';
import { LoopSection } from './LoopSection.js';
import { AgentsSection } from './AgentsSection.js';
import { ComposeSection } from './ComposeSection.js';
import { EditorPrefsSection } from './EditorPrefsSection.js';
import { ShortcutsSection } from './ShortcutsSection.js';
import { UsageSection } from './UsageSection.js';
import { SectionCard } from './fields.js';
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
  { id: 'loop', label: 'Loop' },
  { id: 'agents', label: 'Agents & Launchers' },
  { id: 'compose', label: 'Auto Compose' },
  { id: 'editor', label: 'Editor' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'usage', label: 'Usage' },
  { id: 'advanced', label: 'Advanced' },
];

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The in-app Settings Center: a full-window ledger with a section sidebar.
 *  One themed surface instead of a modal that outgrew the viewport; the
 *  native Settings menu and the command palette jump straight to sections.
 *  Escape with unsaved section drafts opens an inline confirm bar instead
 *  of discarding silently; Tab is trapped inside the surface. */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const { section, onSection, onClose, onTheme, themeId, sessionId, onNotice } = props;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dirtySections, setDirtySections] = useState<ReadonlySet<string>>(() => new Set());
  const [guardOpen, setGuardOpen] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const anyDirty = dirtySections.size > 0;

  const onDirtyChange = useCallback((id: string, dirty: boolean): void => {
    setDirtySections((prev) => {
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void bridge.getSettings().then((s) => alive && setSettings(s));
    void bridge.getAppInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);

  // refs mirror the latest state for the stable window key handler
  const anyDirtyRef = useRef(anyDirty);
  anyDirtyRef.current = anyDirty;
  const guardOpenRef = useRef(guardOpen);
  guardOpenRef.current = guardOpen;

  // role=dialog promises Escape-to-close and an initial focus (the nav, not
  // the close button); also counts toward the global modal depth so app
  // shortcuts stand down behind it
  useEffect(() => {
    navRef.current?.focus();
  }, []);

  useEffect(() => {
    modalOpened();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // an open Select listbox consumes Escape itself — don't stack the
        // guard on top of it
        const active = document.activeElement;
        if (active instanceof Element && active.closest('.select')?.querySelector('[aria-expanded="true"]') !== null) {
          return;
        }
        if (guardOpenRef.current) {
          // a second Escape on the guard confirms the discard
          setGuardOpen(false);
          onClose();
          return;
        }
        if (anyDirtyRef.current) {
          setGuardOpen(true);
          return;
        }
        onClose();
        return;
      }
      if (e.key === 'Tab' && viewRef.current !== null) {
        const items = [...viewRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => !(el as HTMLButtonElement).disabled,
        );
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        const next = e.shiftKey
          ? items[(idx <= 0 ? items.length : idx) - 1]!
          : items[(idx + 1) % items.length]!;
        next.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      modalClosed();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // the guard dissolves once the last dirty section saves or resets
  useEffect(() => {
    if (!anyDirty) setGuardOpen(false);
  }, [anyDirty]);

  useEffect(() => {
    if (guardOpen) keepRef.current?.focus();
  }, [guardOpen]);

  return (
    <div className="settings-view" role="dialog" aria-label="settings" ref={viewRef}>
      <header className="settings-header">
        <span className="pane-title">Settings</span>
        {guardOpen && (
          <div className="settings-dirty-bar" role="status">
            <span>unsaved changes — discard?</span>
            <button type="button" className="btn btn-sm" ref={keepRef} onClick={() => setGuardOpen(false)}>
              keep editing
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={onClose}>
              discard
            </button>
          </div>
        )}
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="close settings">
          close
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="settings sections" ref={navRef}>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`settings-nav-item${n.id === section ? ' settings-nav-item-active' : ''}`}
              aria-current={n.id === section ? 'true' : undefined}
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
            <ModelSection
              settings={settings}
              sessionId={sessionId}
              onSaved={setSettings}
              onNotice={onNotice}
              onDirtyChange={(d) => onDirtyChange('model', d)}
            />
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
              onDirtyChange={(d) => onDirtyChange('sampling', d)}
            />
          ) : section === 'loop' ? (
            <LoopSection settings={settings} onSaved={setSettings} onNotice={onNotice} onDirtyChange={(d) => onDirtyChange('loop', d)} />
          ) : section === 'agents' ? (
            <AgentsSection
              settings={settings}
              sessionId={sessionId}
              onSaved={setSettings}
              onNotice={onNotice}
              onDirtyChange={(d) => onDirtyChange('agents', d)}
            />
          ) : section === 'compose' ? (
            <ComposeSection
              settings={settings}
              onSaved={setSettings}
              onNotice={onNotice}
              onDirtyChange={(d) => onDirtyChange('compose', d)}
            />
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
      <SectionCard title="About" hint="App internals and data location.">
        <div className="settings-kv">
          <span>app</span>
          <span className="settings-mono">{info?.version ?? '…'}</span>
          <span>shell</span>
          <span className="settings-mono">{info?.shell ?? '…'}</span>
          <span>data directory</span>
          <span className="settings-mono">{info?.userData ?? '…'}</span>
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
      </SectionCard>
    </div>
  );
}
