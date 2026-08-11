import React, { useEffect } from 'react';
import { THEMES, type ThemeId } from '../themes.js';

interface ViewMenuProps {
  open: boolean;
  current: ThemeId;
  onSelect(id: ThemeId): void;
  onClose(): void;
}

/** View dropdown: the color theme list, current entry marked. */
export function ViewMenu(props: ViewMenuProps): React.JSX.Element {
  const { open, current, onSelect, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return <></>;

  return (
    <div className="view-menu-backdrop" onMouseDown={onClose}>
      <div className="view-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="view-menu-label">Theme</div>
        {THEMES.map((t) => {
          const active = t.id === current;
          return (
            <button
              key={t.id}
              type="button"
              className={`view-menu-item${active ? ' view-menu-item-current' : ''}`}
              onClick={() => {
                onSelect(t.id);
                onClose();
              }}
            >
              <span className="view-menu-swatch" style={{ background: t.tokens['--accent'] }} />
              <span className="view-menu-name">{t.name}</span>
              {active && <span className="view-menu-check" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
