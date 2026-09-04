/** Settings design-system primitives: SectionCard groups fields into titled
 *  cards; Field renders the uppercase label + control + hint + inline error.
 *  Phase 7 consumes this API — the signatures are a contract. */

export interface SectionCardProps {
  title: string;
  hint?: string;
  children: React.ReactNode;
  /** 'default' | 'danger' — danger renders the card border/title in --err tones. */
  tone?: 'default' | 'danger';
}

export function SectionCard({ title, hint, children, tone = 'default' }: SectionCardProps): React.JSX.Element {
  return (
    <section className={`settings-card${tone === 'danger' ? ' settings-card-danger' : ''}`}>
      <div className="settings-card-head">
        <h3 className="settings-card-title">{title}</h3>
        {hint !== undefined && <p className="settings-card-hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  /** Inline validation message; renders in --err with role=status. When set,
   *  callers that own the control should also set aria-invalid on it (Field
   *  cannot reach into arbitrary children to do so). */
  error?: string;
  htmlFor?: string;
  /** The control (input/textarea/Select/switch row…). */
  children: React.ReactNode;
  /** Full-width field; default fits the surrounding grid column. */
  wide?: boolean;
}

export function Field({ label, hint, error, htmlFor, children, wide }: FieldProps): React.JSX.Element {
  return (
    <div className={`settings-field${wide ? ' settings-field-wide' : ''}`}>
      <label className="settings-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint !== undefined && <span className="settings-hint">{hint}</span>}
      {error !== undefined && (
        <span className="settings-error" role="status" aria-live="polite">
          {error}
        </span>
      )}
    </div>
  );
}
