/**
 * Pure keyboard-navigation state machine for the custom Select listbox.
 * Kept out of the component so the behavior is unit-testable: wrap-around
 * moves, Home/End, and a 500ms typeahead buffer that jumps to the first
 * option whose label starts with the buffer.
 */

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  /** Group header; options render under their section in first-appearance order. */
  section?: string;
}

export interface SelectState {
  open: boolean;
  active: number;
  typed: string;
  typedAt: number;
}

export const selectInit: SelectState = { open: false, active: 0, typed: '', typedAt: 0 };

export type SelectAction =
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'move'; d: 1 | -1 }
  | { t: 'home' }
  | { t: 'end' }
  | { t: 'type'; ch: string; now: number }
  | { t: 'commit' }
  | { t: 'setIndex'; i: number };

const TYPEAHEAD_RESET_MS = 500;

export function selectReduce(s: SelectState, a: SelectAction, opts: SelectOption[]): SelectState {
  const count = opts.length;
  switch (a.t) {
    case 'open':
      return { ...s, open: true, typed: '', typedAt: 0 };
    case 'close':
      return { ...s, open: false, typed: '', typedAt: 0 };
    case 'move': {
      if (count === 0) return s;
      const active = (s.active + a.d + count) % count;
      return { ...s, open: true, active };
    }
    case 'home':
      return { ...s, open: true, active: 0 };
    case 'end':
      return { ...s, open: true, active: Math.max(0, count - 1) };
    case 'setIndex':
      return { ...s, active: Math.min(Math.max(0, a.i), Math.max(0, count - 1)) };
    case 'type': {
      if (count === 0) return s;
      const fresh = a.now - s.typedAt > TYPEAHEAD_RESET_MS;
      const typed = (fresh ? '' : s.typed) + a.ch.toLowerCase();
      const active = Math.max(
        0,
        opts.findIndex((o) => o.label.toLowerCase().startsWith(typed)),
      );
      if (!opts[active]) return { ...s, typed, typedAt: a.now };
      return { ...s, open: true, active, typed, typedAt: a.now };
    }
    case 'commit':
      return { ...s, open: false, typed: '', typedAt: 0 };
  }
}
