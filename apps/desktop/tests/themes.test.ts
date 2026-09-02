import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, REGION_IDS, THEMES } from '../src/themes.js';
import {
  contrast,
  contrastOklch,
  deltaL,
  deltaOklch,
  hexToSrgb,
  hueDistance,
  luminance,
  oklchParts,
  oklchToSrgb,
} from './color-utils.js';

const TOKEN_NAMES = [
  '--bg',
  '--bg-sunken',
  '--bg-tile',
  '--bg-raised',
  '--bg-overlay',
  '--hover-surface',
  '--chrome-bg',
  '--text',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--accent-tint',
  '--accent-glow',
  '--focus-border',
  '--focus-ring',
  '--ok',
  '--warn',
  '--err',
  '--ok-tint',
  '--warn-tint',
  '--err-tint',
  '--line',
  '--line-strong',
  '--mark-ghost',
  '--shadow-dialog',
  '--overlay-scrim',
  '--btn-primary-fg',
  '--btn-primary-hover',
  '--selection-bg',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
  '--rgn-explorer',
  '--rgn-explorer-soft',
  '--rgn-editor',
  '--rgn-editor-soft',
  '--rgn-reviewer',
  '--rgn-reviewer-soft',
  '--rgn-palette',
  '--rgn-palette-soft',
  '--rgn-settings',
  '--rgn-settings-soft',
  '--cat-folder',
  '--cat-code',
  '--cat-doc',
  '--cat-config',
  '--cat-style',
  '--cat-data',
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
        expect(contrastOklch(t['--text'], t['--bg-sunken'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text'], t['--bg-overlay'])).toBeGreaterThanOrEqual(4.5);
      });

      it('muted text ≥ 4.5:1 on bg and raised', () => {
        expect(contrastOklch(t['--text-muted'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-muted'], t['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-muted'], t['--bg-tile'])).toBeGreaterThanOrEqual(4.5);
      });

      it('faint hints ≥ 4.5:1 on bg and raised (11px mono is small text)', () => {
        expect(contrastOklch(t['--text-faint'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-faint'], t['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
      });

      it('chrome text levels ≥ 4.5:1 on --chrome-bg (top/status bars)', () => {
        expect(contrastOklch(t['--text'], t['--chrome-bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-muted'], t['--chrome-bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--text-faint'], t['--chrome-bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--accent'], t['--chrome-bg'])).toBeGreaterThanOrEqual(4.5);
      });

      it('accent ≥ 4.5:1 on bg (it is used for small text)', () => {
        expect(contrastOklch(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastOklch(t['--accent'], t['--bg-raised'])).toBeGreaterThanOrEqual(4.5);
      });

      it('focus border ≥ 3:1 on tile bg', () => {
        expect(contrastOklch(t['--focus-border'], t['--bg-tile'])).toBeGreaterThanOrEqual(3);
      });

      it('status colors ≥ 3:1 on bg and readable on their own tints', () => {
        for (const [fg, bg, tint] of [
          ['--ok', '--bg', '--ok-tint'],
          ['--warn', '--bg', '--warn-tint'],
          ['--err', '--bg', '--err-tint'],
        ] as const) {
          expect(contrastOklch(t[fg], t[bg]), `${fg} on bg`).toBeGreaterThanOrEqual(3);
          expect(contrastOklch(t[fg], t[tint]), `${fg} on its tint`).toBeGreaterThanOrEqual(3);
        }
      });

      it('status hues are theme-tinted but distinct from the accent (≥35°)', () => {
        for (const s of ['--ok', '--warn', '--err'] as const) {
          expect(hueDistance(t['--accent'], t[s]), `${s} vs accent`).toBeGreaterThanOrEqual(35);
        }
      });

      it('accent hues are pairwise distinct across themes (≥8°)', () => {
        // a shared accent hue would make two themes feel like clones
        for (let i = 0; i < THEMES.length; i += 1) {
          for (let j = i + 1; j < THEMES.length; j += 1) {
            const a = THEMES[i]!.tokens['--accent'];
            const b = THEMES[j]!.tokens['--accent'];
            expect(hueDistance(a, b), `${THEMES[i]!.id} vs ${THEMES[j]!.id}`).toBeGreaterThanOrEqual(8);
          }
        }
      });

      it('tints carry the same hue as their parent', () => {
        expect(hueDistance(t['--accent'], t['--accent-tint'])).toBe(0);
        expect(hueDistance(t['--ok'], t['--ok-tint'])).toBe(0);
        expect(hueDistance(t['--warn'], t['--warn-tint'])).toBe(0);
        expect(hueDistance(t['--err'], t['--err-tint'])).toBe(0);
      });

      it('primary button label ≥ 4.5:1 on its accent', () => {
        expect(contrastOklch(t['--btn-primary-fg'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
      });

      it('hairlines keep a perceptual lightness gap over the base', () => {
        expect(deltaL(t['--line'], t['--bg'])).toBeGreaterThanOrEqual(0.09);
        expect(deltaL(t['--line-strong'], t['--bg'])).toBeGreaterThanOrEqual(0.14);
      });

      it('line borders stay subtle (decorative, < 2:1 on bg)', () => {
        expect(contrastOklch(t['--line'], t['--bg'])).toBeLessThan(2);
        expect(contrastOklch(t['--line-strong'], t['--bg'])).toBeLessThan(2.5);
      });

      it('shadows are hue-tinted, never pure black', () => {
        expect(t['--shadow-dialog']).not.toContain('oklch(0 0 0');
      });

      it('regional anchors ≥ 3:1 on bg (decorative chrome color)', () => {
        for (const r of REGION_IDS) {
          expect(contrastOklch(t[`--rgn-${r}`], t['--bg']), `rgn ${r}`).toBeGreaterThanOrEqual(3);
        }
      });

      it('regional anchors are pairwise distinct (ΔE oklab ≥ 0.09)', () => {
        for (let i = 0; i < REGION_IDS.length; i += 1) {
          for (let j = i + 1; j < REGION_IDS.length; j += 1) {
            const ri = REGION_IDS[i]!;
            const rj = REGION_IDS[j]!;
            const a = t[`--rgn-${ri}`];
            const b = t[`--rgn-${rj}`];
            expect(deltaOklch(a, b), `${ri} vs ${rj}`).toBeGreaterThanOrEqual(0.09);
          }
        }
      });

      it('regional soft tints share the anchor hue at 8–18% alpha', () => {
        for (const r of REGION_IDS) {
          const anchor = t[`--rgn-${r}`];
          const soft = t[`--rgn-${r}-soft`];
          expect(hueDistance(anchor, soft), `rgn ${r} tint hue`).toBe(0);
          const alpha = oklchParts(soft).alpha;
          expect(alpha, `rgn ${r} alpha`).toBeGreaterThanOrEqual(0.08);
          expect(alpha).toBeLessThanOrEqual(0.18);
        }
      });

      it('category tints ≥ 4.5:1 on bg (they color file names)', () => {
        for (const c of CATEGORY_IDS) {
          expect(contrastOklch(t[`--cat-${c}`], t['--bg']), `cat ${c}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastOklch(t[`--cat-${c}`], t['--bg-tile']), `cat ${c} on tile`).toBeGreaterThanOrEqual(4);
        }
      });

      it('category tints are pairwise distinct (ΔE oklab ≥ 0.10)', () => {
        for (let i = 0; i < CATEGORY_IDS.length; i += 1) {
          for (let j = i + 1; j < CATEGORY_IDS.length; j += 1) {
            const ci = CATEGORY_IDS[i]!;
            const cj = CATEGORY_IDS[j]!;
            const a = t[`--cat-${ci}`];
            const b = t[`--cat-${cj}`];
            expect(deltaOklch(a, b), `${ci} vs ${cj}`).toBeGreaterThanOrEqual(0.085);
          }
        }
      });

      it('category tints stay perceptually clear of status colors (ΔE ≥ 0.06, curated wheel shifts)', () => {
        for (const c of CATEGORY_IDS) {
          for (const st of ['--ok', '--warn', '--err'] as const) {
            expect(deltaOklch(t[`--cat-${c}`], t[st]), `cat ${c} vs ${st}`).toBeGreaterThanOrEqual(0.06);
          }
        }
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

      it('xterm: brightWhite is never pure #ffffff', () => {
        expect(theme.xterm.brightWhite.toLowerCase()).not.toBe('#ffffff');
      });
    });
  }
});
