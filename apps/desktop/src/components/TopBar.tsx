import React from 'react';

export type AppTab = 'node' | 'editor' | 'test';

interface TopBarProps {
  tab: AppTab;
  onTabChange(tab: AppTab): void;
}

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: 'editor', label: 'File Editor' },
  { id: 'node', label: 'Node' },
  { id: 'test', label: 'Test' },
];

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { tab, onTabChange } = props;
  return (
    <header className="top-bar">
      <nav className="top-bar-tabs" aria-label="views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab-btn${tab === t.id ? ' tab-btn-active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
