import { useEffect, useState } from 'react';

export const REDUCED_MOTION = process.env.FRAKTOLE_REDUCED_MOTION === '1';

/** frame schedule for a fade: step indices at which brightness flips */
export function fadeFrames(durationMs: number, stepMs = 60): number[] {
  const frames: number[] = [];
  for (let t = stepMs; t < durationMs; t += stepMs) frames.push(t);
  return frames;
}

/**
 * true while the initial "fade" of the current render is still playing.
 * Re-mounts (via key) replay the fade — used for scene transitions.
 */
export function useFade(durationMs = 140): boolean {
  const [fading, setFading] = useState(!REDUCED_MOTION);
  useEffect(() => {
    if (REDUCED_MOTION) {
      setFading(false);
      return;
    }
    const frames = fadeFrames(durationMs);
    const timers = frames.map((t, i) =>
      setTimeout(() => {
        if (i === frames.length - 1) setFading(false);
      }, t),
    );
    return () => timers.forEach(clearTimeout);
  }, [durationMs]);
  return fading;
}
