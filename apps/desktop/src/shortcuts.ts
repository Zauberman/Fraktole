/** Single source of truth for every keyboard shortcut in the app.
 *
 *  The global keymap (App.tsx), the status-bar hint strip, the Help modal
 *  and the command palette all render from this registry — hand-written
 *  hint duplicates are what let `alt+1/2/3` drift from the real 4-tab
 *  binding. Add a shortcut here, wire the handler where it belongs, and
 *  every surface updates.
 */

export type ShortcutScope = 'global' | 'node' | 'editor' | 'terminal' | 'test';

export interface ShortcutDef {
  /** Stable id — the command palette references these. */
  id: string;
  /** Display form: `Ctrl+Shift+T`. */
  keys: string;
  /** Compact status-bar form: `ctrl+shift t`. */
  hint: string;
  /** Noun for the status-bar strip form: `ctrl+shift t tile`. */
  noun: string;
  label: string;
  scope: ShortcutScope;
  /** Whether the shortcut appears in the status-bar hint strip. */
  strip?: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'tab.editor', keys: 'Alt+1', hint: 'alt+1', noun: '', label: 'File Editor tab', scope: 'global' },
  { id: 'tab.node', keys: 'Alt+2', hint: 'alt+2', noun: '', label: 'Node tab', scope: 'global' },
  { id: 'tab.test', keys: 'Alt+3', hint: 'alt+3', noun: '', label: 'Test tab', scope: 'global' },
  { id: 'tab.remote', keys: 'Alt+4', hint: 'alt+4', noun: '', label: 'Remote tab', scope: 'global' },
  { id: 'palette.files', keys: 'Ctrl+P', hint: 'ctrl+p', noun: 'files', label: 'Quick open (files)', scope: 'global', strip: true },
  { id: 'palette.commands', keys: 'Ctrl+Shift+P', hint: 'ctrl+shift p', noun: 'commands', label: 'Command palette', scope: 'global', strip: true },
  { id: 'settings.open', keys: 'Ctrl+,', hint: 'ctrl+,', noun: 'settings', label: 'Open settings', scope: 'global', strip: true },
  { id: 'tile.new', keys: 'Ctrl+Shift+T', hint: 'ctrl+shift t', noun: 'tile', label: 'New tile', scope: 'node' },
  { id: 'project.add', keys: 'Ctrl+Shift+O', hint: 'ctrl+shift o', noun: 'project', label: 'Add project folder', scope: 'node' },
  { id: 'tile.close', keys: 'Ctrl+Shift+W', hint: 'ctrl+shift w', noun: 'close', label: 'Close focused tile', scope: 'node' },
  { id: 'tile.zoom', keys: 'Ctrl+Shift+Enter', hint: 'enter zoom', noun: 'zoom', label: 'Zoom focused tile', scope: 'node' },
  { id: 'tile.focusPrev', keys: 'Ctrl+Shift+Left', hint: '', noun: '', label: 'Focus previous tile', scope: 'node' },
  { id: 'tile.focusNext', keys: 'Ctrl+Shift+Right', hint: '', noun: '', label: 'Focus next tile', scope: 'node' },
  { id: 'reviewer.focus', keys: 'Ctrl+Shift+0', hint: '0', noun: 'reviewer', label: 'Focus the reviewer', scope: 'node' },
  { id: 'tile.focusN', keys: 'Ctrl+Shift+1..9', hint: '', noun: '', label: 'Focus tile 1-9', scope: 'node' },
  { id: 'file.save', keys: 'Ctrl+S', hint: 'ctrl+s', noun: 'save', label: 'Save file', scope: 'editor' },
  { id: 'search.project', keys: 'Ctrl+Shift+F', hint: 'ctrl+shift f', noun: 'search', label: 'Search in project', scope: 'editor' },
  { id: 'term.search', keys: 'Ctrl+Shift+F', hint: '', noun: '', label: 'Search terminal scrollback', scope: 'terminal' },
  { id: 'term.copy', keys: 'Ctrl+Shift+C', hint: '', noun: '', label: 'Copy terminal selection', scope: 'terminal' },
  { id: 'term.paste', keys: 'Ctrl+Shift+V', hint: '', noun: '', label: 'Paste into terminal', scope: 'terminal' },
  { id: 'test.url', keys: 'Ctrl+L', hint: '', noun: '', label: 'Focus the test URL bar', scope: 'test' },
];

/** Status-bar hint strip, in display order (only entries flagged `strip`). */
export function statusHints(): string[] {
  return SHORTCUTS.filter((s) => s.strip).map((s) => `${s.hint} ${s.noun}`);
}

/** All shortcuts in a scope (palette + Settings▸Shortcuts). */
export function shortcutsByScope(scope: ShortcutScope): ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.scope === scope);
}
