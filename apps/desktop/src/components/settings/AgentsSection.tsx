import { useState } from 'react';
import { bridge } from '../../ipc.js';
import type { Settings } from '../../shared/ipc.js';
import { sanitizeAllowedLaunchers } from '../../shared/launchers.js';

export interface AgentsSectionProps {
  settings: Settings;
  sessionId: string | null;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
}

/** Settings▸Agents & Launchers — the launcher the reviewer spawns for
 *  agents, plus the extra shell-tile launchers it may start beyond the
 *  built-in defaults. */
export function AgentsSection(props: AgentsSectionProps): React.JSX.Element {
  const { settings, sessionId, onSaved, onNotice } = props;
  const [agentCommand, setAgentCommand] = useState(settings.reviewer.agentCommand ?? '');
  const [launchers, setLaunchers] = useState<string[]>(settings.reviewer.allowedLaunchers ?? []);
  const [newLauncher, setNewLauncher] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addLauncher = (): void => {
    const value = newLauncher.trim();
    if (value.length === 0) return;
    const next = sanitizeAllowedLaunchers([...launchers, value]) ?? [];
    if (!next.includes(value)) {
      setError('rejected: too many entries, too long, or invalid');
      return;
    }
    setError(null);
    setLaunchers(next);
    setNewLauncher('');
  };

  const save = (): void => {
    setSaving(true);
    const next: Settings = {
      ...settings,
      reviewer: {
        ...settings.reviewer,
        agentCommand: agentCommand.trim() || undefined,
        allowedLaunchers: launchers.length > 0 ? launchers : undefined,
      },
    };
    void bridge
      .setSettings(next)
      .then((merged) => {
        onSaved(merged);
        onNotice('launcher config saved');
      })
      .catch(() => onNotice('failed to save launchers'))
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">
        What the reviewer may start. The agent launcher is the command spawned for agent tiles; the allowlist gates which extra
        launchers may run inside a shell tile. The defaults (opencode, agy, claude, codex, gemini, aider, shell) always apply.
      </p>
      <label className="settings-field settings-field-wide">
        agent launcher (optional)
        <input
          value={agentCommand}
          onChange={(e) => setAgentCommand(e.target.value)}
          placeholder="e.g. opencode — spawned agents run it"
          autoComplete="off"
        />
      </label>
      <div className="settings-field settings-field-wide">
        allowed launchers (beyond the defaults)
        <ul className="settings-list">
          {launchers.map((l) => (
            <li key={l} className="settings-list-row">
              <span className="settings-mono">{l}</span>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={`remove ${l}`}
                onClick={() => setLaunchers((ls) => ls.filter((x) => x !== l))}
              >
                remove
              </button>
            </li>
          ))}
          {launchers.length === 0 && <li className="settings-list-row settings-list-empty">no extra launchers</li>}
        </ul>
        <div className="settings-inline-add">
          <input
            value={newLauncher}
            onChange={(e) => {
              setNewLauncher(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLauncher();
              }
            }}
            placeholder="add a launcher command…"
            autoComplete="off"
          />
          <button type="button" className="btn btn-sm" onClick={addLauncher}>
            add
          </button>
        </div>
        {error && <span className="settings-error">{error}</span>}
      </div>
      <div className="settings-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>
          {saving ? 'saving…' : 'save'}
        </button>
        {sessionId && (
          <button type="button" className="btn btn-sm" onClick={() => void bridge.restartReviewer(sessionId).then(() => onNotice('reviewer restarted'))}>
            restart reviewer now
          </button>
        )}
      </div>
    </div>
  );
}
