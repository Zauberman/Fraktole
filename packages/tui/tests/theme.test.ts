import { describe, expect, it } from 'vitest';
import { COLORS, STATUS_BADGES, STATUS_BADGE_COLORS, fmtClock, fmtElapsed, fmtStamp, truncate } from '../src/theme.js';

describe('design tokens', () => {
  it('defines the full palette as hex colors', () => {
    const expected = ['bg', 'bgRaised', 'bgDim', 'text', 'muted', 'dim', 'accent', 'err', 'warn', 'info', 'ok', 'border'];
    for (const key of expected) {
      expect(COLORS[key as keyof typeof COLORS]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('never uses pure black or pure white', () => {
    const values = Object.values(COLORS);
    expect(values).not.toContain('#000000');
    expect(values).not.toContain('#ffffff');
  });

  it('covers every task status with a badge and a color', () => {
    const statuses = ['queued', 'planning', 'running', 'gating', 'merging', 'done', 'failed', 'cancelled'];
    for (const s of statuses) {
      expect(STATUS_BADGES[s as keyof typeof STATUS_BADGES]).toBeTruthy();
      expect(STATUS_BADGE_COLORS[s as keyof typeof STATUS_BADGE_COLORS]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('formatters', () => {
  it('formats elapsed and clock time', () => {
    expect(fmtElapsed(new Date(Date.now() - 125_000).toISOString(), Date.now())).toBe('02:05');
    expect(fmtClock(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fmtStamp(new Date().toISOString())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('truncates with a typographic ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a very long goal text', 10)).toHaveLength(10);
  });
});
