import { describe, expect, it } from 'vitest';
import { fmtTokens } from '../src/components/settings/tokens.js';

describe('fmtTokens', () => {
  it('formats the boundaries (3 significant digits, no trailing zeros)', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1000)).toBe('1k');
    expect(fmtTokens(1234)).toBe('1.23k');
    expect(fmtTokens(999999)).toBe('1M');
    expect(fmtTokens(1250000)).toBe('1.25M');
  });

  it('matches the documented shapes and degenerate inputs', () => {
    expect(fmtTokens(12300)).toBe('12.3k');
    expect(fmtTokens(1000000)).toBe('1M');
    expect(fmtTokens(-5)).toBe('0');
    expect(fmtTokens(NaN)).toBe('0');
  });
});
