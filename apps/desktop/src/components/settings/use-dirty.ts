import { useCallback, useEffect, useRef, useState } from 'react';

/** Draft state for settings sections with a Save button: `draft` is what the
 *  inputs edit, `dirty` compares it against the last saved/reset baseline
 *  (structural equality — small plain objects and arrays only). */
export function useDirty<T>(initial: T): {
  draft: T;
  setDraft: (updater: (d: T) => T) => void;
  reset: (next: T) => void;
  dirty: boolean;
  markSaved: (next: T) => void;
} {
  const [baseline, setBaseline] = useState<T>(initial);
  const [draft, setDraftState] = useState<T>(initial);

  const setDraft = useCallback((updater: (d: T) => T) => {
    setDraftState((d) => updater(d));
  }, []);

  // both adopt `next` as the new baseline: markSaved after a successful save,
  // reset when the user discards their changes
  const markSaved = useCallback((next: T) => {
    setBaseline(next);
    setDraftState(next);
  }, []);
  const reset = markSaved;

  const dirty = !equals(baseline, draft);
  return { draft, setDraft, reset, dirty, markSaved };
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equals(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  return ka.length === kb.length && ka.every((k) => equals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const SAVED_FLASH_MS = 1500;

/** The "saved" tick: `flash()` flips `saved` on for ~1.5s after a successful
 *  save so the button briefly reads "saved". Timer is cleaned up on unmount. */
export function useSavedFlash(): { saved: boolean; flash: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setSaved(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), SAVED_FLASH_MS);
  }, []);
  return { saved, flash };
}
