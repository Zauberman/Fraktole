import React from 'react';

export type AppTab = 'node' | 'reviewer' | 'editor';

interface TopBarProps {
  viewOpen: boolean;
  onViewClick(): void;
  tab: AppTab;
  onTabChange(tab: AppTab): void;
}

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: 'editor', label: 'File Editor' },
  { id: 'node', label: 'Node' },
  { id: 'reviewer', label: 'Reviewer' },
];

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { viewOpen, onViewClick, tab, onTabChange } = props;
  return (
    <header className="top-bar">
      <span className="top-bar-wordmark">
        FRAKTOLE<span className="boot-dot">.</span>
      </span>
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
      <div className="top-bar-actions">
        <button type="button" className="view-btn" onClick={onViewClick} aria-expanded={viewOpen}>
          View
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
            className={`view-btn-caret${viewOpen ? ' view-btn-caret-open' : ''}`}
          >
            <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
          </svg>
        </button>
      </div>
    </header>
  );
}
