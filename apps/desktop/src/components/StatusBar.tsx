import React from 'react';
import type { SessionStatus } from '../ipc.js';

interface StatusBarProps {
  sessionName: string | null;
  sessionState: SessionStatus;
  tileCount: number;
  focusedCwd: string | null;
  info: string;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const { sessionName, sessionState, tileCount, focusedCwd, info } = props;
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
        <span className="status-hints">
          <span>ctrl+shift T tile</span>
          <span>W close</span>
          <span>enter zoom</span>
          <span>alt+1/2/3 tabs</span>
        </span>
        <span className="status-info">{info}</span>
      </span>
    </footer>
  );
}
