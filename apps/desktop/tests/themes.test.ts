import { describe, expect, it } from 'vitest';
import { THEMES } from '../src/themes.js';
import { contrast, contrastOklch, hexToSrgb, luminance, oklchToSrgb } from './color-utils.js';

const TOKEN_NAMES = [
  '--bg',
  '--bg-raised',
  '--bg-overlay',
  '--bg-tile',
  '--text',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--focus-border',
  '--focus-ring',
  '--ok',
  '--warn',
  '--err',
  '--line',
  '--line-strong',
  '--accent-glow',
  '--accent-tint',
  '--mark-ghost',
  '--shadow-dialog',
  '--overlay-scrim',
  '--btn-primary-fg',
  '--btn-primary-hover',
] as const;

const XTERM_TEXT_COLORS = [
  'foreground',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

const XTERM_MID_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

describe('color-utils', () => {
  it('parses oklch and produces sRGB in range', () => {
    const white = oklchToSrgb('oklch(1 0 0)');
    expect(white.r).toBeGreaterThan(0.98);
    expect(white.g).toBeGreaterThan(0.98);
    expect(white.b).toBeGreaterThan(0.98);
    const black = oklchToSrgb('oklch(0 0 0)');
    expect(black.r).toBeLessThan(0.02);
    expect(luminance(black)).toBeLessThan(0.001);
  });

  it('matches reference luminances for sRGB primaries', () => {
    // WCAG reference values: white 1.0, black 0.0
    expect(luminance({ r: 1, g: 1, b: 1 })).toBeCloseTo(1, 4);
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 4);
    // green primary 0.7152
    expect(luminance({ r: 0, g: 1, b: 0 })).toBeCloseTo(0.7152, 4);
    // contrast white vs black = 21
    expect(contrast({ r: 1, g: 1, b: 1 }, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 3);
  });

  it('parses hex colors', () => {
    expect(hexToSrgb('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToSrgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('oklch midtones convert to expected luminance (no double gamma)', () => {
    // oklch L 0.5 grey → oklab L 0.5 → LMS linear 0.125 → luminance ≈ 0.125
    expect(luminance(oklchToSrgb('oklch(0.5 0 0)'))).toBeCloseTo(0.125, 2);
    // oklch 0.75 grey → linear 0.421875
    expect(luminance(oklchToSrgb('oklch(0.75 0 0)'))).toBeCloseTo(0.421875, 2);
  });
});

describe('theme token completeness', () => {
  for (const theme of THEMES) {
    it(`${theme.name}: defines every token`, () => {
      for (const name of TOKEN_NAMES) {
        expect(typeof theme.tokens[name], `${theme.id}:${name}`).toBe('string');
        expect(theme.tokens[name]!.length, `${theme.id}:${name}`).toBeGreaterThan(0);
      }
    });
  }
});

describe('theme contrast matrix', () => {
  for (const theme of THEMES) {
    const t = theme.tokens;

    describe(theme.name, () => {
      it('body text ≥ 4.5:1 on every surface', () => {
        expect(contrastOklch(t['--text'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text'], t['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text'], t['--bg-tile'])).toBeGreaterThanOrEqual(4.5);
      });

      it('muted text ≥ 4.5:1 on bg and raised', () => {
        expect(contrastOklch(t['--text-muted'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-muted'], t['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
      });

      it('faint hints ≥ 3:1 on bg and raised', () => {
        expect(contrastOklch(t['--text-faint'], t['--bg'])).toBeGreaterThanOrEqual(3);
        expect(contrastOklch(t['--text-faint'], t['--bg-raised'])).toBeGreaterThanOrEqual(3);
      });

      it('accent ≥ 3:1 on bg', () => {
        expect(contrastOklch(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(3);
      });

      it('focus border ≥ 3:1 on tile bg', () => {
        expect(contrastOklch(t['--focus-border'], t['--bg-tile'])).toBeGreaterThanOrEqual(3);
      });

      it('status colors ≥ 3:1 on bg', () => {
        expect(contrastOklch(t['--ok'], t['--bg'])).toBeGreaterThanOrEqual(3);
        expect(contrastOklch(t['--warn'], t['--bg'])).toBeGreaterThanOrEqual(3);
        expect(contrastOklch(t['--err'], t['--bg'])).toBeGreaterThanOrEqual(3);
      });

      it('primary button label ≥ 3:1 on its accent', () => {
        expect(contrastOklch(t['--btn-primary-fg'], t['--accent'])).toBeGreaterThanOrEqual(3);
      });

      it('line borders stay subtle (decorative, < 2:1 on bg)', () => {
        expect(contrastOklch(t['--line'], t['--bg'])).toBeLessThan(2);
        expect(contrastOklch(t['--line-strong'], t['--bg'])).toBeLessThan(2.5);
      });

      it('xterm: foreground + bright colors ≥ 4.5:1 on terminal bg', () => {
        const bgHex = hexToSrgb(theme.xterm.background);
        const lightBg = luminance(bgHex) > 0.5;
        for (const name of XTERM_TEXT_COLORS) {
          const c = theme.xterm[name as keyof typeof theme.xterm];
          expect(typeof c, `${theme.id}:xterm:${name}`).toBe('string');
          // on light terminals the ANSI "white"/brightWhite ARE the background
          // family — exempt them there; foreground + the rest must still pass
          if (lightBg && (name === 'white' || name === 'brightWhite')) continue;
          expect(contrast(hexToSrgb(c as string), bgHex), `${theme.id}:xterm:${name}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('xterm: standard colors ≥ 3:1 on terminal bg', () => {
        const bgHex = hexToSrgb(theme.xterm.background);
        for (const name of XTERM_MID_COLORS) {
          const c = theme.xterm[name as keyof typeof theme.xterm];
          expect(contrast(hexToSrgb(c as string), bgHex), `${theme.id}:xterm:${name}`).toBeGreaterThanOrEqual(3);
        }
      });

      it('xterm: cursor and cursor accent readable on each other', () => {
        expect(contrast(hexToSrgb(theme.xterm.cursorAccent), hexToSrgb(theme.xterm.cursor))).toBeGreaterThanOrEqual(3);
      });
    });
  }
});
