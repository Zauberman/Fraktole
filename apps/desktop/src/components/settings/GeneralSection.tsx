import { useState } from 'react';
import { bridge } from '../../ipc.js';
import { THEMES } from '../../themes.js';
import type { Settings } from '../../shared/ipc.js';

export interface GeneralSectionProps {
  settings: Settings;
  themeId: string;
  onTheme: (id: string) => void;
  onSaved: (s: Settings) => void;
  onNotice: (message: string) => void;
}

/** Settings▸General — theme gallery (live swatches) + desktop notifications. */
export function GeneralSection(props: GeneralSectionProps): React.JSX.Element {
  const { settings, themeId, onTheme, onSaved, onNotice } = props;
  const [notifications, setNotifications] = useState(settings.notifications?.enabled ?? true);

  const toggleNotifications = (): void => {
    const enabled = !notifications;
    setNotifications(enabled);
    void bridge
      .setSettings({ notifications: { enabled } })
      .then(onSaved)
      .catch(() => onNotice('failed to save the notification setting'));
  };

  return (
    <div className="settings-section">
      <p className="settings-lede">Appearance and ambient app behavior.</p>
      <div className="settings-field settings-field-wide">
        theme
        <div className="settings-themes" role="radiogroup" aria-label="color theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === themeId}
              className={`settings-theme-card${t.id === themeId ? ' settings-theme-card-active' : ''}`}
              onClick={() => onTheme(t.id)}
            >
              <span className="settings-theme-swatch">
                <span style={{ background: t.tokens['--bg'] }} />
                <span style={{ background: t.tokens['--bg-raised'] }} />
                <span style={{ background: t.tokens['--accent'] }} />
              </span>
              <span className="settings-theme-name">{t.name}</span>
            </button>
          ))}
        </div>
        <span className="settings-hint">applied instantly and persisted ({THEMES.length} themes)</span>
      </div>
      <div className="settings-field settings-field-wide">
        desktop notifications
        <div className="settings-switch-row">
          <button
            type="button"
            className={`switch${notifications ? ' switch-on' : ''}`}
            role="switch"
            aria-checked={notifications}
            aria-label="desktop notifications"
            onClick={toggleNotifications}
          >
            <span className="switch-knob" />
          </button>
          <span className="settings-hint">
            notify when the reviewer needs input, a goal is met, or an auto compose run ends — never while the window is focused
          </span>
        </div>
      </div>
    </div>
  );
}
