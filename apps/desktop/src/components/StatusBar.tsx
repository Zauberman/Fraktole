import React from 'react';

interface StatusBarProps {
  tileCount: number;
  focusedCwd: string | null;
  info: string;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const { tileCount, focusedCwd, info } = props;
  return (
    <footer className="status-bar">
      <span>
        {tileCount} {tileCount === 1 ? 'tile' : 'tiles'}
        {focusedCwd ? ` · ${focusedCwd}` : ''}
      </span>
      <span className="status-right">
        <span className="status-hints">
          <span>ctrl+shift T tile</span>
          <span>W close</span>
          <span>enter zoom</span>
          <span>O add folder</span>
        </span>
        <span className="status-info">{info}</span>
      </span>
    </footer>
  );
}
