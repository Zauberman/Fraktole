import React from 'react';
import type { SessionStatus } from '../ipc.js';
import { statusHints } from '../shortcuts.js';

interface StatusBarProps {
  sessionName: string | null;
  sessionState: SessionStatus;
  tileCount: number;
  focusedCwd: string | null;
  info: string;
  /** Git branch of the active project (null = no repo / no project). */
  branch: string | null;
  /** Open editor tabs with unsaved changes. */
  dirtyCount: number;
  /** Clicking the hint strip opens the shortcuts reference. */
  onOpenShortcuts: () => void;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const { sessionName, sessionState, tileCount, focusedCwd, info, branch, dirtyCount, onOpenShortcuts } = props;
  return (
    <footer className="status-bar">
      <span>
        {sessionName !== null ? (
          <>
            {sessionName}
            <span className={`status-state status-state-${sessionState}`}>· {sessionState}</span>
            {' · '}
          </>
        ) : (
          ''
        )}
        {tileCount} {tileCount === 1 ? 'tile' : 'tiles'}
        {focusedCwd ? ` · ${focusedCwd}` : ''}
      </span>
      <span className="status-right">
        {dirtyCount > 0 && <span className="status-dirty">● {dirtyCount} unsaved</span>}
        {branch && <span className="status-branch" title="git branch">{branch}</span>}
        <span
          className="status-hints"
          title="keyboard shortcuts — click for the full list"
          onClick={onOpenShortcuts}
          role="button"
        >
          {statusHints().map((h) => (
            <span key={h}>{h}</span>
          ))}
        </span>
        <span className="status-info">{info}</span>
      </span>
    </footer>
  );
}
