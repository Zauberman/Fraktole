/** Loop-carrier cadence derivation. The poll interval ("loops hunger") is
 *  the user-facing knob; the re-check backstop and the stall stand-down are
 *  anchored to wall-time so changing the poll rate scales their frequency
 *  without changing their meaning:
 *  - a goal is re-checked after ~90s of silence at any poll rate;
 *  - a stalled autonomous loop stands down after ~45s of ledger-less wakes.
 *  Presets (settings UI): lazy 90s, calm 45s, standard 15s; the stored
 *  value is one number (reviewer.pollSeconds, unset = 15). */
export const RECHECK_WALL_MS = 90_000;
export const STALE_WALL_MS = 45_000;

export const POLL_SECONDS_MIN = 2;
export const POLL_SECONDS_MAX = 600;

export type LoopCadence = {
  pollIntervalMs: number;
  recheckPolls: number;
  staleWakeLimit: number;
};

export function deriveLoopCadence(pollSeconds?: number): LoopCadence {
  const p = Math.min(POLL_SECONDS_MAX, Math.max(POLL_SECONDS_MIN, Math.round(pollSeconds ?? 15))) * 1000;
  return {
    pollIntervalMs: p,
    recheckPolls: Math.max(1, Math.round(RECHECK_WALL_MS / p)),
    staleWakeLimit: Math.max(2, Math.round(STALE_WALL_MS / p)),
  };
}
