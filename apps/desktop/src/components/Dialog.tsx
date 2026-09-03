import { useEffect, useRef, type ReactNode } from 'react';
import { modalClosed, modalOpened } from '../modal-guard.js';

export type DialogAccent = 'palette' | 'explorer' | 'reviewer' | 'settings' | 'editor' | 'err';
export type DialogSize = 'sm' | 'md' | 'lg';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in the standard actions row (buttons). */
  footer?: ReactNode;
  /** Use the wide dialog variant (custom loop editor etc.). */
  wide?: boolean;
  /** Regional personality: tints the frame, title and backdrop. */
  accent?: DialogAccent;
  /** sm = namer plates, md = standard, lg = codex / launcher cards. */
  size?: DialogSize;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The shared modal primitive. Every dialog in the app renders through this:
 *  backdrop click (self target only) closes, Escape closes capture-phase,
 *  Tab is trapped inside the panel, focus lands on the first focusable
 *  child. Regional `accent` gives each surface its own personality via
 *  data-accent styling in dialogs.css. */
export function Dialog({ title, onClose, children, footer, wide, accent, size }: DialogProps): React.JSX.Element {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  // a Dialog counts toward the global modal depth for the whole time it is
  // mounted — the global shortcut layer reads this and stands down
  useEffect(() => {
    modalOpened();
    return () => modalClosed();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current !== null) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => !(el as HTMLButtonElement).disabled,
        );
        if (items.length === 0) return;
        const active = document.activeElement;
        const idx = items.indexOf(active as HTMLElement);
        e.preventDefault();
        const next = e.shiftKey
          ? items[(idx <= 0 ? items.length : idx) - 1]!
          : items[(idx + 1) % items.length]!;
        next.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const sizeClass = size === 'sm' ? ' dialog-sm' : size === 'lg' ? ' dialog-lg' : '';

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className={`dialog${wide ? ' dialog-wide' : ''}${sizeClass}`}
        role="dialog"
        aria-label={title}
        data-accent={accent}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>
        {children}
        {footer !== undefined && <div className="dialog-actions">{footer}</div>}
      </section>
    </div>
  );
}
