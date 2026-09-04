import { useEffect, useState } from 'react';
import { Select } from '../Select.js';
import { bridge } from '../../ipc.js';
import { EDITOR_FONT_MAX, EDITOR_FONT_MIN, normalizeEditorSettings } from '../editor/use-editor-settings.js';
import { Field, SectionCard } from './fields.js';

export interface EditorPrefsSectionProps {
  onNotice: (message: string) => void;
}

/** Settings▸Editor — file-editor preferences, applied live via the
 *  settings broadcast (no save button needed; each change persists). */
export function EditorPrefsSection(props: EditorPrefsSectionProps): React.JSX.Element {
  const { onNotice } = props;
  const [fontSize, setFontSize] = useState(13);
  const [wrap, setWrap] = useState(true);
  const [autoSave, setAutoSave] = useState(false);

  useEffect(() => {
    let alive = true;
    void bridge
      .getSettings()
      .then((s) => {
        if (!alive) return;
        const v = normalizeEditorSettings(s.editor);
        setFontSize(v.fontSize);
        setWrap(v.wrap);
        setAutoSave(v.autoSave);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const persist = (patch: { fontSize?: number; wrap?: boolean; autoSave?: boolean }): void => {
    const nextFontSize = patch.fontSize ?? fontSize;
    const next = {
      // 13 is the hook's default — persist it as unset
      fontSize: nextFontSize === 13 ? undefined : nextFontSize,
      wrap: patch.wrap ?? wrap,
      autoSave: patch.autoSave ?? autoSave,
    };
    void bridge
      .setSettings({ editor: next })
      .catch(() => onNotice('failed to save editor settings'));
  };

  const sizes: number[] = [];
  for (let s = EDITOR_FONT_MIN; s <= EDITOR_FONT_MAX; s += 1) sizes.push(s);

  return (
    <div className="settings-section">
      <p className="settings-lede">File Editor behavior — every change applies to open editors immediately.</p>
      <SectionCard title="Editor">
        <Field label="font size (px)">
          <Select
            ariaLabel="font size"
            value={String(fontSize)}
            onChange={(v) => {
              const n = Number(v);
              setFontSize(n);
              persist({ fontSize: n });
            }}
            options={sizes.map((s) => ({ value: String(s), label: String(s) }))}
          />
        </Field>
        <Field label="line wrapping" wide>
          <div className="settings-switch-row">
            <button
              type="button"
              className={`switch${wrap ? ' switch-on' : ''}`}
              role="switch"
              aria-checked={wrap}
              aria-label="line wrapping"
              onClick={() => {
                setWrap(!wrap);
                persist({ wrap: !wrap });
              }}
            >
              <span className="switch-knob" />
            </button>
            <span className="settings-hint">wrap long lines instead of horizontal scrolling</span>
          </div>
        </Field>
        <Field label="auto-save" wide>
          <div className="settings-switch-row">
            <button
              type="button"
              className={`switch${autoSave ? ' switch-on' : ''}`}
              role="switch"
              aria-checked={autoSave}
              aria-label="auto-save"
              onClick={() => {
                setAutoSave(!autoSave);
                persist({ autoSave: !autoSave });
              }}
            >
              <span className="switch-knob" />
            </button>
            <span className="settings-hint">save dirty files ~0.8s after the last keystroke (Ctrl+S still saves)</span>
          </div>
        </Field>
      </SectionCard>
    </div>
  );
}
