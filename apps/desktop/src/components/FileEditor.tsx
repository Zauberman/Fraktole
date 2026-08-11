import React, { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { history, historyKeymap } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import type { OpenFile } from '../file-state.js';

interface FileEditorProps {
  projectPath: string | null;
  files: OpenFile[];
  activePath: string | null;
  onActivate(path: string): void;
  onClose(path: string): void;
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
const frakTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.5' },
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

function Editor({ file, onUpdate, onSave }: { file: OpenFile; onUpdate(path: string, c: string): void; onSave(path: string): Promise<boolean> }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langFactory = file.lang === 'plaintext' ? undefined : LANG[file.lang];
    const lang = langFactory ? langFactory() : [];
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void onSave(file.path);
              return true;
            },
          },
        ]),
        history(),
        keymap.of(historyKeymap),
        lang,
        frakTheme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(file.readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onUpdate(file.path, update.state.doc.toString());
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

  return <div className="file-editor-host" ref={hostRef} />;
}

/**
 * The File Editor tab: open files as sub-tabs, one CodeMirror editor each
 * (kept mounted so scroll positions survive tab switches), Ctrl+S saves.
 */
export function FileEditor(props: FileEditorProps): React.JSX.Element {
  const { projectPath, files, activePath, onActivate, onClose, onUpdate, onSave } = props;

  return (
    <div className="file-editor">
      {projectPath === null ? (
        <div className="orch-hint reviewer-hint">open a project to browse and edit its files</div>
      ) : files.length === 0 ? (
        <div className="orch-hint reviewer-hint">
          no files open — click a file in the left sidebar ({projectPath})
        </div>
      ) : (
        <>
          <div className="file-editor-tabs">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`file-tab${f.path === activePath ? ' file-tab-active' : ''}`}
                onClick={() => onActivate(f.path)}
              >
                <span className="file-tab-name">{f.name}</span>
                {f.dirty && <span className="file-tab-dirty">●</span>}
                {f.readOnly && <span className="file-tab-ro">ro</span>}
                <span
                  className="file-tab-close"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(f.path);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onClose(f.path);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="file-editor-body">
            {files.map((f) => (
              <div
                key={f.path}
                className={`file-editor-pane${f.path === activePath ? '' : ' file-editor-pane-hidden'}`}
              >
                <Editor file={f} onUpdate={onUpdate} onSave={onSave} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
