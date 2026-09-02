import { SHORTCUTS, shortcutsByScope, type ShortcutScope } from '../../shortcuts.js';

const SCOPES: Array<{ id: ShortcutScope; label: string }> = [
  { id: 'global', label: 'global' },
  { id: 'node', label: 'node workspace' },
  { id: 'editor', label: 'file editor' },
  { id: 'terminal', label: 'terminal' },
  { id: 'test', label: 'test browser' },
];

/** Settings▸Shortcuts — read-only reference rendered from the same registry
 *  the keymap and status bar use, so it cannot drift. */
export function ShortcutsSection(): React.JSX.Element {
  return (
    <div className="settings-section">
      <p className="settings-lede">
        Every binding, from the single shortcut registry the app runs on. The command palette (Ctrl+Shift+P) also lists these as
        commands.
      </p>
      {SCOPES.map((s) => (
        <div key={s.id} className="settings-field settings-field-wide">
          {s.label}
          <table className="settings-shortcuts">
            <tbody>
              {shortcutsByScope(s.id).map((sc) => (
                <tr key={sc.id}>
                  <td className="settings-mono">{sc.keys}</td>
                  <td>{sc.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <span className="settings-hint">{SHORTCUTS.length} bindings registered</span>
    </div>
  );
}
