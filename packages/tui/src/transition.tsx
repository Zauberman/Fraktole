import { useEffect, useState } from 'react';
import type { TaskStatus } from '@fraktole/core';
import type { ReactNode } from 'react';
import { Backdrop } from './primitives.js';
import { COLORS } from './theme.js';
import { REDUCED_MOTION, useFade } from './motion.js';

/**
 * Scene transition: briefly paints the scene area with the dim backdrop, then
 * reveals the new scene. Remounts (key=tab) replay the fade.
 */
export function SceneTransition({ children }: { children: ReactNode }): JSX.Element {
  const fading = useFade(140);
  if (REDUCED_MOTION || !fading) {
    return <>{children}</>;
  }
  return <Backdrop bg={COLORS.bgDim} height={40} />;
}

/** pulses the tile header when the task status changes (accent flash) */
export function useStatusPulse(status: TaskStatus): boolean {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (REDUCED_MOTION) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 260);
    return () => clearTimeout(t);
  }, [status]);
  return pulse;
}
