import React from 'react';
import type { Project } from '../ipc.js';

interface ExplorerProps {
  projects: Project[];
  activePath: string | null;
  onOpenProject(path: string): void;
  onRemoveProject(path: string): void;
  onAddFolder(): void;
}

export function Explorer(props: ExplorerProps): React.JSX.Element {
  const { projects, activePath, onOpenProject, onRemoveProject, onAddFolder } = props;
  return (
    <div className="explorer">
      <header className="pane-header explorer-header">
        <span className="pane-title">
          Projects<span className="explorer-count">{projects.length > 0 ? ` ${projects.length}` : ''}</span>
        </span>
        <button type="button" className="tile-btn explorer-add" title="add folder" onClick={onAddFolder}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <path d="M5.5 1 V10 M1 5.5 H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
          </svg>
        </button>
      </header>
      {projects.length === 0 ? (
        <div className="explorer-empty">
          no projects yet — open a terminal anywhere and it will appear here
        </div>
      ) : (
        <ul className="explorer-list">
          {projects.map((p) => {
            const active = activePath === p.path;
            return (
              <li
                key={p.path}
                className={`explorer-item${active ? ' explorer-item-active' : ''}`}
                title={p.path}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onOpenProject(p.path);
                }}
              >
                <div className="explorer-item-main">
                  <div className="explorer-item-name">{p.name}</div>
                  <div className="explorer-item-path">{p.path}</div>
                </div>
                <button
                  type="button"
                  className="tile-btn explorer-item-remove"
                  title="remove project"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onRemoveProject(p.path)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
