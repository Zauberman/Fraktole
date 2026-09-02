import React, { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import type { OpenFile, RevealRequest } from '../../file-state.js';
import type { EditorSettingsView } from './use-editor-settings.js';

interface CodeMirrorPaneProps {
  file: OpenFile;
  settings: EditorSettingsView;
  reveal: RevealRequest | null;
  onUpdate(path: string, content: string): void;
  onSave(path: string): Promise<boolean>;
}

const LANG: Record<string, () => ReturnType<typeof javascript>> = {
  javascript,
  json,
  python,
  markdown,
  html,
  css,
};

/** Theme that tracks the app's CSS variables (live theme switching works). */
const cmTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-faint)',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--accent-tint)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--focus-ring)',
  },
});

/** Scroller typography lives in its own fragment so the font size can be
 *  swapped through a compartment without rebuilding the state. */
function scrollerTheme(fontSize: number) {
  return EditorView.theme({
    '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: `${fontSize}px`, lineHeight: '1.5' },
  });
}

/** One CodeMirror view per OpenFile (kept mounted so scroll positions
 *  survive tab switches). Font size and line wrapping go through
 *  compartments so editor settings land live. */
export function CodeMirrorPane({ file, settings, reveal, onUpdate, onSave }: CodeMirrorPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fontComp = useRef(new Compartment()).current;
  const wrapComp = useRef(new Compartment()).current;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langFactory = file.lang === 'plaintext' ? undefined : LANG[file.lang];
    const lang = langFactory ? langFactory() : [];
    const initial = settingsRef.current;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void onSaveRef.current(file.path);
              return true;
            },
          },
        ]),
        history(),
        keymap.of(historyKeymap),
        lang,
        cmTheme,
        fontComp.of(scrollerTheme(initial.fontSize)),
        wrapComp.of(initial.wrap ? EditorView.lineWrapping : []),
        EditorState.readOnly.of(file.readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onUpdateRef.current(file.path, update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [file.path]);

  // editor settings are live: reconfigure through the compartments
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        fontComp.reconfigure(scrollerTheme(settings.fontSize)),
        wrapComp.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
      ],
    });
  }, [settings, fontComp, wrapComp]);

  // reveal: one-shot per nonce — select the line and center it
  useEffect(() => {
    if (reveal === null || reveal.path !== file.path) return;
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    if (doc.lines === 0) return;
    const wanted = Math.round(reveal.line);
    if (!Number.isFinite(wanted)) return;
    const line = doc.line(Math.min(Math.max(1, wanted), doc.lines));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [reveal, file.path]);

  return <div className="file-editor-host" ref={hostRef} />;
}
