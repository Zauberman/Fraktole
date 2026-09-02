import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { selectInit, selectReduce, type SelectAction, type SelectOption, type SelectState } from '../select-nav.js';

export type { SelectOption };

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  ariaLabel: string;
  placeholder?: string;
}

interface Section {
  label: string | null;
  items: Array<{ option: SelectOption; index: number }>;
}

/** Groups flat options into sections in first-appearance order. */
function groupOptions(options: SelectOption[]): Section[] {
  const sections: Section[] = [];
  const byLabel = new Map<string, Section>();
  options.forEach((option, index) => {
    const key = option.section ?? '';
    let sec = byLabel.get(key);
    if (sec === undefined) {
      sec = { label: option.section ?? null, items: [] };
      byLabel.set(key, sec);
      sections.push(sec);
    }
    sec.items.push({ option, index });
  });
  return sections;
}

/** The bespoke listbox that replaces native <select>: trigger + popover,
 *  keyboard-first (arrows wrap, Home/End, typeahead, Enter commits,
 *  Escape cancels), ARIA listbox/option roles, section headers. */
export function Select(props: SelectProps): React.JSX.Element {
  const { value, options, onChange, ariaLabel, placeholder } = props;
  // the reducer needs the current options for wrap/typeahead; a ref keeps
  // dispatch identity stable while always reading fresh options
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, dispatch] = useReducer(
    (s: SelectState, a: SelectAction) => selectReduce(s, a, optionsRef.current),
    selectInit,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const selected = options.find((o) => o.value === value);
  const sections = useMemo(() => groupOptions(options), [options]);

  useEffect(() => {
    if (state.open) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [state.open, state.active]);

  const commit = (index: number): void => {
    const opt = options[index];
    if (opt === undefined) return;
    onChange(opt.value);
    dispatch({ t: 'commit' });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!state.open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dispatch({ t: 'open' });
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        dispatch({ t: 'move', d: 1 });
        break;
      case 'ArrowUp':
        e.preventDefault();
        dispatch({ t: 'move', d: -1 });
        break;
      case 'Home':
        e.preventDefault();
        dispatch({ t: 'home' });
        break;
      case 'End':
        e.preventDefault();
        dispatch({ t: 'end' });
        break;
      case 'Enter':
        e.preventDefault();
        commit(state.active);
        break;
      case 'Escape':
        e.preventDefault();
        dispatch({ t: 'close' });
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          dispatch({ t: 'type', ch: e.key, now: Date.now() });
        }
    }
  };

  return (
    <div className="select" ref={rootRef}>
      <button
        type="button"
        className="select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={state.open}
        onClick={() => dispatch(state.open ? { t: 'close' } : { t: 'open' })}
        onKeyDown={onKeyDown}
      >
        <span className={selected === undefined ? 'select-placeholder' : 'select-value'}>
          {selected?.label ?? placeholder ?? 'select…'}
        </span>
        <span className="select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {state.open && (
        <>
          <div className="select-backdrop" onMouseDown={() => dispatch({ t: 'close' })} />
          <div className="select-pop" role="listbox" aria-label={ariaLabel}>
            {sections.map((sec) => (
              <div key={sec.label ?? '__ungrouped'} className="select-section">
                {sec.label !== null && <div className="select-section-label">{sec.label}</div>}
                {sec.items.map(({ option, index }) => (
                  <button
                    key={option.value}
                    ref={index === state.active ? activeRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={`select-option${index === state.active ? ' select-option-active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(index);
                    }}
                    onMouseMove={() => dispatch({ t: 'setIndex', i: index })}
                  >
                    <span className="select-option-label">{option.label}</span>
                    {option.hint !== undefined && <span className="select-option-hint">{option.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
