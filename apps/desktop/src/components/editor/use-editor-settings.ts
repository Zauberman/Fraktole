import { useEffect, useState } from 'react';
import { bridge } from '../../ipc.js';
import type { EditorSettings } from '../../shared/ipc.js';

export interface EditorSettingsView {
  fontSize: number;
  wrap: boolean;
  autoSave: boolean;
}

export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 20;

const EDITOR_FONT_DEFAULT = 13;

const DEFAULT_SETTINGS: EditorSettingsView = { fontSize: EDITOR_FONT_DEFAULT, wrap: true, autoSave: false };

/** Fills in defaults and clamps the font size to the supported range. */
export function normalizeEditorSettings(editor: EditorSettings | undefined): EditorSettingsView {
  if (!editor) return DEFAULT_SETTINGS;
  const size = editor.fontSize;
  const fontSize =
    typeof size === 'number' && Number.isFinite(size)
      ? Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(size)))
      : EDITOR_FONT_DEFAULT;
  return { fontSize, wrap: editor.wrap !== false, autoSave: editor.autoSave === true };
}

/** Live file-editor settings: fetched once, then updated on every
 *  settings broadcast so changes apply without a remount. */
export function useEditorSettings(): EditorSettingsView {
  const [settings, setSettings] = useState<EditorSettingsView>(DEFAULT_SETTINGS);
  useEffect(() => {
    let alive = true;
    void bridge
      .getSettings()
      .then((s) => {
        if (alive) setSettings(normalizeEditorSettings(s.editor));
      })
      .catch(() => undefined);
    const off = bridge.onSettingsChanged((s) => setSettings(normalizeEditorSettings(s.editor)));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return settings;
}
