import React, { useEffect, useRef } from 'react';

interface DividerProps {
  onDrag(clientX: number): void;
}

/**
 * 6px column-resize strip between the three panes. Pointer-drag while held;
 * the caller translates clientX into pane percentages.
 */
export function Divider({ onDrag }: DividerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const down = (e: PointerEvent): void => {
      dragging.current = true;
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('is-resizing');
    };
    const move = (e: PointerEvent): void => {
      if (dragging.current) onDrag(e.clientX);
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
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [onDrag]);

  return <div ref={ref} className="divider" role="separator" aria-orientation="vertical" />;
}
