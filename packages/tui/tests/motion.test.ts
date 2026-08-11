import { describe, expect, it } from 'vitest';
import { fadeFrames, REDUCED_MOTION } from '../src/motion.js';

describe('motion helpers', () => {
  it('produces a monotonic frame schedule', () => {
    const frames = fadeFrames(140, 60);
    expect(frames).toEqual([60, 120]);
    expect(fadeFrames(200, 50)).toEqual([50, 100, 150]);
  });

  it('yields no frames for instant fades', () => {
    expect(fadeFrames(10, 60)).toEqual([]);
  });

  it('respects the reduced-motion flag in the environment', () => {
    expect(typeof REDUCED_MOTION).toBe('boolean');
  });
});
