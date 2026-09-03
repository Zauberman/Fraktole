import React, { useEffect, useRef } from 'react';

interface DividerProps {
  onDrag(clientX: number): void;
}

/**
 * 6px column-resize strip between the three panes. Pointer-drag while held;
 * the caller translates clientX into pane percentages. Moves are rAF-
 * coalesced: one state update per frame instead of per pointer event.
 */
export function Divider({ onDrag }: DividerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const rafRef = useRef<number | null>(null);
  const latestX = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const schedule = (x: number): void => {
      latestX.current = x;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onDragRef.current(latestX.current);
      });
    };
    const down = (e: PointerEvent): void => {
      dragging.current = true;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('is-resizing');
    };
    const move = (e: PointerEvent): void => {
      if (dragging.current) schedule(e.clientX);
    };
    const up = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.classList.remove('is-resizing');
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  return <div ref={ref} className="divider" role="separator" aria-orientation="vertical" />;
}
