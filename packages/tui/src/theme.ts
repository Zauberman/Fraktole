import type { TaskStatus } from '@fraktole/core';

// Design tokens — oklch approximations via ANSI 24-bit truecolor.
// One accent hue, neutral backgrounds with a cool blue cast, semantic colors.
export const COLORS = {
  bg: '#111318', // oklch(0.15 0.01 260) — the canvas
  bgRaised: '#1a1d24', // oklch(0.19 0.012 260) — bars, sidebar, panels
  bgDim: '#15171d', // oklch(0.165 0.01 260) — inactive tiles
  text: '#eae8e3', // oklch(0.95 0.005 95)
  muted: '#9c9a92', // oklch(0.65 0.01 260)
  dim: '#5f5e59', // oklch(0.5 0.008 260) — micro-labels
  accent: '#4ecb8e', // oklch(0.75 0.15 160)
  err: '#ff6b6b',
  warn: '#f5c542',
  info: '#5aa9e6',
  ok: '#7bc96f',
  border: '#262a33', // oklch(0.22 0.012 260) — hairline dividers
} as const;

export const STATUS_BADGE_COLORS: Record<TaskStatus, string> = {
  queued: COLORS.muted,
  planning: COLORS.info,
  running: COLORS.accent,
  gating: COLORS.warn,
  merging: COLORS.info,
  done: COLORS.ok,
  failed: COLORS.err,
  cancelled: COLORS.dim,
};

export const STATUS_BADGES: Record<TaskStatus, string> = {
  queued: 'QUEUED',
  planning: 'PLANNING',
  running: 'RUNNING',
  gating: 'GATE',
  merging: 'MERGING',
  done: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

export function fmtElapsed(since: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(since));
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtClock(now: number): string {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function fmtStamp(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// legacy aliases, removed when the tree/log components are rewritten in pass 3
export const STATUS_CHIP_COLORS = STATUS_BADGE_COLORS;
export const STATUS_CHIPS: Record<TaskStatus, string> = {
  queued: '[QUEUED]',
  planning: '[PLANNING]',
  running: '[RUNNING]',
  gating: '[GATE]',
  merging: '[MERGING]',
  done: '[DONE]',
  failed: '[FAILED]',
  cancelled: '[CANCELLED]',
};

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** glyph-free connection word: pure typography, colored by state */
export function connectionWord(connected: boolean): string {
  return connected ? 'CONNECTED' : 'connecting';
}
