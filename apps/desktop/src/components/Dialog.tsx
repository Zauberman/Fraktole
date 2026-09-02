import { useEffect, type ReactNode } from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in the standard actions row (buttons). */
  footer?: ReactNode;
  /** Use the wide dialog variant (custom loop editor etc.). */
  wide?: boolean;
}

/** The shared modal primitive. Every dialog in the app renders through this:
 *  backdrop click (self target only) closes, Escape closes capture-phase,
 *  Enter handling stays with the dialog's own inputs. Replaces the six
 *  hand-rolled `dialog-backdrop > dialog` skeletons whose backdrop behavior
 *  had drifted apart. */
export function Dialog({ title, onClose, children, footer, wide }: DialogProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`dialog${wide ? ' dialog-wide' : ''}`}
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>
        {children}
        {footer !== undefined && <div className="dialog-actions">{footer}</div>}
      </section>
    </div>
  );
}
