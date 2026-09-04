import { describe, expect, it } from 'vitest';
import { deriveLoopCadence, RECHECK_WALL_MS, STALE_WALL_MS } from '../src/shared/loop-cadence.js';

describe('deriveLoopCadence', () => {
  it('derives the preset table (wall-time anchored)', () => {
    // lazy 90s: re-check every poll, stall guard at the 2-poll floor
    expect(deriveLoopCadence(90)).toEqual({ pollIntervalMs: 90_000, recheckPolls: 1, staleWakeLimit: 2 });
    // calm 45s
    expect(deriveLoopCadence(45)).toEqual({ pollIntervalMs: 45_000, recheckPolls: 2, staleWakeLimit: 2 });
    // standard 15s (also the unset default)
    expect(deriveLoopCadence(15)).toEqual({ pollIntervalMs: 15_000, recheckPolls: 6, staleWakeLimit: 3 });
    expect(deriveLoopCadence(undefined)).toEqual(deriveLoopCadence(15));
    // ravenous custom: backstop and guard scale up, floors hold
    expect(deriveLoopCadence(3)).toEqual({ pollIntervalMs: 3_000, recheckPolls: 30, staleWakeLimit: 15 });
    // bounds clamp
    expect(deriveLoopCadence(1).pollIntervalMs).toBe(2_000);
    expect(deriveLoopCadence(10_000).pollIntervalMs).toBe(600_000);
    expect(deriveLoopCadence(0)).toEqual(deriveLoopCadence(2));
    expect(deriveLoopCadence(-5)).toEqual(deriveLoopCadence(2));
    // fractional seconds round to whole seconds
    expect(deriveLoopCadence(7.6).pollIntervalMs).toBe(8_000);
  });

  it('keeps backstop and stall guard within one poll of their wall-time anchors unless floored', () => {
    for (const s of [2, 3, 5, 7, 15, 30, 45, 60, 90, 120, 300, 600]) {
      const c = deriveLoopCadence(s);
      const halfPoll = c.pollIntervalMs / 2 + 1;
      // anchor holds only where the raw target clears the floor; at slow
      // poll rates the floor deliberately exceeds the wall-time anchor
      const recheckTarget = Math.round(RECHECK_WALL_MS / c.pollIntervalMs);
      if (recheckTarget >= 1) {
        expect(Math.abs(c.recheckPolls * c.pollIntervalMs - RECHECK_WALL_MS)).toBeLessThanOrEqual(halfPoll);
      } else {
        expect(c.recheckPolls).toBe(1);
      }
      const staleTarget = Math.round(STALE_WALL_MS / c.pollIntervalMs);
      if (staleTarget >= 2) {
        expect(Math.abs(c.staleWakeLimit * c.pollIntervalMs - STALE_WALL_MS)).toBeLessThanOrEqual(halfPoll);
      } else {
        expect(c.staleWakeLimit).toBe(2);
      }
      // floors: at least one poll between re-checks, two between stand-downs
      expect(c.recheckPolls).toBeGreaterThanOrEqual(1);
      expect(c.staleWakeLimit).toBeGreaterThanOrEqual(2);
    }
  });
});
