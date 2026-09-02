import { contrastOklch, oklchParts } from './color.js';

export const THEME_IDS = ["sable", "midnight", "gold", "amber", "forest", "neon", "paper", "ember", "ocean", "violet", "slate", "rose", "ivory"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface XtermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Regional chrome families (vibrant-chrome architecture): each chrome
 * region carries its own per-theme hue anchor + premixed soft tint.
 * Tiles/terminals never consume these — chrome only.
 */
export type RegionId = 'explorer' | 'editor' | 'reviewer' | 'palette' | 'settings';
export const REGION_IDS: readonly RegionId[] = ['explorer', 'editor', 'reviewer', 'palette', 'settings'];

/**
 * Explorer file-kind tints (replace icons): semantic categories, one hue
 * per kind, neutral files fall back to --text-faint.
 */
export type CategoryId = 'folder' | 'code' | 'doc' | 'config' | 'style' | 'data';
export const CATEGORY_IDS: readonly CategoryId[] = ['folder', 'code', 'doc', 'config', 'style', 'data'];

export type SurfaceColors = {
  [K in RegionId as `--rgn-${K}`]: string;
} & {
  [K in RegionId as `--rgn-${K}-soft`]: string;
} & {
  [K in CategoryId as `--cat-${K}`]: string;
};

/** The hand-authored per-theme tokens (everything except the derived surfaces). */
export type BaseTokens = { [K in Exclude<keyof ThemeTokens, keyof SurfaceColors>]: string };

export interface BaseTheme {
  id: ThemeId;
  name: string;
  tokens: BaseTokens;
  xterm: XtermPalette;
}

/**
 * Theme token contract. Every color a component can use lives here — a
 * component styles itself exclusively through these names. Rules enforced
 * by the test suite (tests/themes.test.ts + tests/token-coverage.test.ts):
 *
 *   - text levels are small-text safe (≥ 4.5:1 on every surface)
 *   - status hues are theme-tinted but ≥ 35° away from the accent
 *   - tints are the same color at ~12% alpha
 *   - shadows are hue-tinted near-black, never pure black
 *   - hairlines keep a perceptual lightness gap over the base
 *   - --chrome-bg (bars) keeps every chrome text level readable
 *   - regional anchors ≥ 3:1 on bg, pairwise ΔE-distinct
 *   - category tints ≥ 4.5:1 on bg (they color file names)
 */
export interface ThemeTokens extends SurfaceColors {
  // surfaces — six levels from deepest well to overlay
  '--bg': string;
  '--bg-sunken': string;
  '--bg-tile': string;
  '--bg-raised': string;
  '--bg-overlay': string;
  '--hover-surface': string;
  '--chrome-bg': string;
  // text — three levels
  '--text': string;
  '--text-muted': string;
  '--text-faint': string;
  // accent family
  '--accent': string;
  '--accent-strong': string;
  '--accent-tint': string;
  '--accent-glow': string;
  '--focus-border': string;
  '--focus-ring': string;
  // status family — theme-tinted, hue-distinct from the accent
  '--ok': string;
  '--warn': string;
  '--err': string;
  '--ok-tint': string;
  '--warn-tint': string;
  '--err-tint': string;
  // lines — hairline hierarchy
  '--line': string;
  '--line-strong': string;
  // misc
  '--mark-ghost': string;
  '--shadow-dialog': string;
  '--overlay-scrim': string;
  '--btn-primary-fg': string;
  '--btn-primary-hover': string;
  '--selection-bg': string;
  '--scrollbar-thumb': string;
  '--scrollbar-thumb-hover': string;
}

export interface FraktoleTheme {
  id: ThemeId;
  name: string;
  tokens: ThemeTokens;
  xterm: XtermPalette;
}

export const DEFAULT_THEME: ThemeId = 'sable';

/**
 * Hue wheels (accent / ok / warn / err) — the coherence rule: each theme
 * keeps its personality hue for the accent, and the status hues are tuned
 * to sit ≥ 35° away while carrying the theme's warmth. Neutrals carry the
 * theme's hue family. Sable is the flagship warm default; slate is the
 * quietest (lowest chroma) and neon the loudest (divergent chrome).
 */
const BASE_THEMES: readonly BaseTheme[] = [
  {
    id: "sable",
    name: "Sable",
    tokens: {
      "--bg": "oklch(0.160 0.012 60.0)",
      "--bg-sunken": "oklch(0.108 0.011 60.0)",
      "--bg-tile": "oklch(0.136 0.012 60.0)",
      "--bg-raised": "oklch(0.206 0.014 60.0)",
      "--bg-overlay": "oklch(0.238 0.014 60.0)",
      "--hover-surface": "oklch(0.257 0.014 60.0)",
      "--chrome-bg": "oklch(0.222 0.014 60.0)",
      "--text": "oklch(0.950 0.010 70.0)",
      "--text-muted": "oklch(0.740 0.016 65.0)",
      "--text-faint": "oklch(0.630 0.015 65.0)",
      "--accent": "oklch(0.830 0.13 65.0)",
      "--accent-strong": "oklch(0.890 0.11 65.0)",
      "--accent-tint": "oklch(0.830 0.13 65.0 / 0.12)",
      "--accent-glow": "oklch(0.830 0.13 65.0 / 0.08)",
      "--focus-border": "oklch(0.730 0.12 65.0)",
      "--focus-ring": "oklch(0.630 0.11 65.0 / 0.50)",
      "--ok": "oklch(0.810 0.14 130.0)",
      "--warn": "oklch(0.850 0.15 30.0)",
      "--err": "oklch(0.730 0.18 20.0)",
      "--ok-tint": "oklch(0.810 0.14 130.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.15 30.0 / 0.12)",
      "--err-tint": "oklch(0.730 0.18 20.0 / 0.12)",
      "--line": "oklch(0.340 0.015 60.0)",
      "--line-strong": "oklch(0.436 0.016 60.0)",
      "--mark-ghost": "oklch(0.340 0.014 60.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.17 0.01 60 / 0.35), 0 24px 60px oklch(0.17 0.01 60 / 0.5)",
      "--overlay-scrim": "oklch(0.110 0.008 60.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.02 60.0)",
      "--btn-primary-hover": "oklch(0.890 0.11 65.0)",
      "--selection-bg": "oklch(0.830 0.13 65.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.430 0.016 60.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.530 0.017 60.0 / 0.80)"
    },
    xterm: {
      "background": "#14100b",
      "foreground": "#f0e8d8",
      "cursor": "#d8a94e",
      "cursorAccent": "#1a1208",
      "selectionBackground": "rgba(216, 169, 78, 0.25)",
      "black": "#1a1710",
      "red": "#e0605a",
      "green": "#9cae55",
      "yellow": "#d4a45a",
      "blue": "#7fa0c9",
      "magenta": "#c79ac7",
      "cyan": "#5fb0a0",
      "white": "#f0e8d8",
      "brightBlack": "#837c6e",
      "brightRed": "#f0837c",
      "brightGreen": "#b6c878",
      "brightYellow": "#e8bd82",
      "brightBlue": "#9dbfe0",
      "brightMagenta": "#dbb2db",
      "brightCyan": "#8cd0c0",
      "brightWhite": "#f7f3e8"
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    tokens: {
      "--bg": "oklch(0.150 0.012 255.0)",
      "--bg-sunken": "oklch(0.098 0.01 255.0)",
      "--bg-tile": "oklch(0.126 0.011 255.0)",
      "--bg-raised": "oklch(0.196 0.013 255.0)",
      "--bg-overlay": "oklch(0.228 0.014 255.0)",
      "--hover-surface": "oklch(0.247 0.014 255.0)",
      "--chrome-bg": "oklch(0.212 0.013 255.0)",
      "--text": "oklch(0.960 0.006 95.0)",
      "--text-muted": "oklch(0.740 0.012 255.0)",
      "--text-faint": "oklch(0.630 0.011 255.0)",
      "--accent": "oklch(0.820 0.15 170.0)",
      "--accent-strong": "oklch(0.880 0.13 170.0)",
      "--accent-tint": "oklch(0.820 0.15 170.0 / 0.12)",
      "--accent-glow": "oklch(0.820 0.15 170.0 / 0.08)",
      "--focus-border": "oklch(0.720 0.14 170.0)",
      "--focus-ring": "oklch(0.620 0.13 170.0 / 0.50)",
      "--ok": "oklch(0.800 0.15 125.0)",
      "--warn": "oklch(0.850 0.15 85.0)",
      "--err": "oklch(0.720 0.19 22.0)",
      "--ok-tint": "oklch(0.800 0.15 125.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.15 85.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.19 22.0 / 0.12)",
      "--line": "oklch(0.330 0.014 255.0)",
      "--line-strong": "oklch(0.426 0.015 255.0)",
      "--mark-ghost": "oklch(0.315 0.015 255.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.01 255 / 0.35), 0 24px 60px oklch(0.16 0.01 255 / 0.55)",
      "--overlay-scrim": "oklch(0.100 0.008 255.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.160 0.02 170.0)",
      "--btn-primary-hover": "oklch(0.880 0.13 170.0)",
      "--selection-bg": "oklch(0.820 0.15 170.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.015 255.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.016 255.0 / 0.80)"
    },
    xterm: {
      "background": "#101418",
      "foreground": "#ece8df",
      "cursor": "#4ecb8e",
      "cursorAccent": "#171a20",
      "selectionBackground": "rgba(78, 203, 142, 0.25)",
      "black": "#171a20",
      "red": "#ff6b6b",
      "green": "#4ecb8e",
      "yellow": "#f5c542",
      "blue": "#7aa2f7",
      "magenta": "#d2a5ff",
      "cyan": "#56c8d8",
      "white": "#ece8df",
      "brightBlack": "#7b828c",
      "brightRed": "#ff8f8f",
      "brightGreen": "#7ee2ad",
      "brightYellow": "#f7d97a",
      "brightBlue": "#9db9ff",
      "brightMagenta": "#dfc0ff",
      "brightCyan": "#8adce8",
      "brightWhite": "#f2f5f2"
    },
  },
  {
    id: "gold",
    name: "Gold",
    tokens: {
      "--bg": "oklch(0.160 0.012 75.0)",
      "--bg-sunken": "oklch(0.108 0.011 75.0)",
      "--bg-tile": "oklch(0.136 0.012 75.0)",
      "--bg-raised": "oklch(0.206 0.014 75.0)",
      "--bg-overlay": "oklch(0.238 0.014 75.0)",
      "--hover-surface": "oklch(0.257 0.014 75.0)",
      "--chrome-bg": "oklch(0.222 0.014 75.0)",
      "--text": "oklch(0.950 0.01 85.0)",
      "--text-muted": "oklch(0.740 0.02 80.0)",
      "--text-faint": "oklch(0.630 0.02 80.0)",
      "--accent": "oklch(0.830 0.13 95.0)",
      "--accent-strong": "oklch(0.890 0.11 95.0)",
      "--accent-tint": "oklch(0.830 0.13 95.0 / 0.12)",
      "--accent-glow": "oklch(0.830 0.13 95.0 / 0.08)",
      "--focus-border": "oklch(0.730 0.12 95.0)",
      "--focus-ring": "oklch(0.630 0.11 95.0 / 0.50)",
      "--ok": "oklch(0.800 0.14 145.0)",
      "--warn": "oklch(0.840 0.13 45.0)",
      "--err": "oklch(0.720 0.18 25.0)",
      "--ok-tint": "oklch(0.800 0.14 145.0 / 0.12)",
      "--warn-tint": "oklch(0.840 0.13 45.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.18 25.0 / 0.12)",
      "--line": "oklch(0.340 0.016 75.0)",
      "--line-strong": "oklch(0.436 0.017 75.0)",
      "--mark-ghost": "oklch(0.335 0.015 75.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.17 0.01 75 / 0.35), 0 24px 60px oklch(0.17 0.01 75 / 0.5)",
      "--overlay-scrim": "oklch(0.110 0.008 75.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.02 75.0)",
      "--btn-primary-hover": "oklch(0.890 0.11 95.0)",
      "--selection-bg": "oklch(0.830 0.13 95.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.430 0.017 75.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.530 0.018 75.0 / 0.80)"
    },
    xterm: {
      "background": "#131209",
      "foreground": "#f0e9d6",
      "cursor": "#d4b45a",
      "cursorAccent": "#191611",
      "selectionBackground": "rgba(212, 180, 90, 0.25)",
      "black": "#1a1813",
      "red": "#e0605a",
      "green": "#9cae55",
      "yellow": "#d4b45a",
      "blue": "#7fa0c9",
      "magenta": "#c79ac7",
      "cyan": "#5fb0b0",
      "white": "#f0e9d6",
      "brightBlack": "#837c6e",
      "brightRed": "#f0837c",
      "brightGreen": "#b6c878",
      "brightYellow": "#e8cd82",
      "brightBlue": "#9dbfe0",
      "brightMagenta": "#dbb2db",
      "brightCyan": "#8cd0d0",
      "brightWhite": "#f7f3e8"
    },
  },
  {
    id: "amber",
    name: "Amber",
    tokens: {
      "--bg": "oklch(0.150 0.02 55.0)",
      "--bg-sunken": "oklch(0.098 0.019 55.0)",
      "--bg-tile": "oklch(0.126 0.02 55.0)",
      "--bg-raised": "oklch(0.196 0.022 55.0)",
      "--bg-overlay": "oklch(0.228 0.022 55.0)",
      "--hover-surface": "oklch(0.247 0.022 55.0)",
      "--chrome-bg": "oklch(0.212 0.022 55.0)",
      "--text": "oklch(0.950 0.012 70.0)",
      "--text-muted": "oklch(0.740 0.02 60.0)",
      "--text-faint": "oklch(0.630 0.02 60.0)",
      "--accent": "oklch(0.820 0.16 75.0)",
      "--accent-strong": "oklch(0.880 0.14 75.0)",
      "--accent-tint": "oklch(0.820 0.16 75.0 / 0.12)",
      "--accent-glow": "oklch(0.820 0.16 75.0 / 0.08)",
      "--focus-border": "oklch(0.720 0.15 75.0)",
      "--focus-ring": "oklch(0.620 0.14 75.0 / 0.50)",
      "--ok": "oklch(0.800 0.15 140.0)",
      "--warn": "oklch(0.840 0.15 120.0)",
      "--err": "oklch(0.720 0.18 25.0)",
      "--ok-tint": "oklch(0.800 0.15 140.0 / 0.12)",
      "--warn-tint": "oklch(0.840 0.15 120.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.18 25.0 / 0.12)",
      "--line": "oklch(0.330 0.02 55.0)",
      "--line-strong": "oklch(0.426 0.022 55.0)",
      "--mark-ghost": "oklch(0.325 0.02 55.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.02 55 / 0.35), 0 24px 60px oklch(0.16 0.02 55 / 0.5)",
      "--overlay-scrim": "oklch(0.100 0.015 55.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.03 55.0)",
      "--btn-primary-hover": "oklch(0.880 0.14 75.0)",
      "--selection-bg": "oklch(0.820 0.16 75.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.022 55.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.023 55.0 / 0.80)"
    },
    xterm: {
      "background": "#110f0b",
      "foreground": "#f2e6d2",
      "cursor": "#e8a33d",
      "cursorAccent": "#1a140c",
      "selectionBackground": "rgba(232, 163, 61, 0.25)",
      "black": "#1c160f",
      "red": "#e0605a",
      "green": "#a8a04e",
      "yellow": "#e8a33d",
      "blue": "#8a9fc0",
      "magenta": "#c49ab8",
      "cyan": "#5ca8a0",
      "white": "#f2e6d2",
      "brightBlack": "#8d8574",
      "brightRed": "#f0837c",
      "brightGreen": "#c2ba72",
      "brightYellow": "#f5bb66",
      "brightBlue": "#a8bcd8",
      "brightMagenta": "#dbb2ce",
      "brightCyan": "#8cc8c0",
      "brightWhite": "#f8f2e6"
    },
  },
  {
    id: "forest",
    name: "Forest",
    tokens: {
      "--bg": "oklch(0.150 0.012 150.0)",
      "--bg-sunken": "oklch(0.098 0.011 150.0)",
      "--bg-tile": "oklch(0.126 0.011 150.0)",
      "--bg-raised": "oklch(0.196 0.014 150.0)",
      "--bg-overlay": "oklch(0.228 0.015 150.0)",
      "--hover-surface": "oklch(0.247 0.014 150.0)",
      "--chrome-bg": "oklch(0.212 0.014 150.0)",
      "--text": "oklch(0.950 0.01 140.0)",
      "--text-muted": "oklch(0.740 0.015 150.0)",
      "--text-faint": "oklch(0.630 0.014 150.0)",
      "--accent": "oklch(0.860 0.15 160.0)",
      "--accent-strong": "oklch(0.920 0.12 160.0)",
      "--accent-tint": "oklch(0.860 0.15 160.0 / 0.12)",
      "--accent-glow": "oklch(0.860 0.15 160.0 / 0.08)",
      "--focus-border": "oklch(0.760 0.13 160.0)",
      "--focus-ring": "oklch(0.660 0.12 160.0 / 0.50)",
      "--ok": "oklch(0.820 0.14 120.0)",
      "--warn": "oklch(0.850 0.15 85.0)",
      "--err": "oklch(0.730 0.19 25.0)",
      "--ok-tint": "oklch(0.820 0.14 120.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.15 85.0 / 0.12)",
      "--err-tint": "oklch(0.730 0.19 25.0 / 0.12)",
      "--line": "oklch(0.330 0.015 150.0)",
      "--line-strong": "oklch(0.426 0.016 150.0)",
      "--mark-ghost": "oklch(0.335 0.014 150.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.01 150 / 0.35), 0 24px 60px oklch(0.16 0.01 150 / 0.5)",
      "--overlay-scrim": "oklch(0.100 0.01 150.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.02 150.0)",
      "--btn-primary-hover": "oklch(0.920 0.12 160.0)",
      "--selection-bg": "oklch(0.860 0.15 160.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.016 150.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.017 150.0 / 0.80)"
    },
    xterm: {
      "background": "#0f120e",
      "foreground": "#e8ecdf",
      "cursor": "#9fe0a8",
      "cursorAccent": "#13180f",
      "selectionBackground": "rgba(159, 224, 168, 0.25)",
      "black": "#181a14",
      "red": "#e0605a",
      "green": "#9fe0a8",
      "yellow": "#d4d05e",
      "blue": "#8aa8c4",
      "magenta": "#c4a0c0",
      "cyan": "#64b8a8",
      "white": "#e8ecdf",
      "brightBlack": "#7c8579",
      "brightRed": "#f0837c",
      "brightGreen": "#c2f0c8",
      "brightYellow": "#e8e48a",
      "brightBlue": "#aac6dc",
      "brightMagenta": "#dcb8d8",
      "brightCyan": "#8cd8c8",
      "brightWhite": "#f3f6ee"
    },
  },
  {
    id: "neon",
    name: "Neon",
    tokens: {
      "--bg": "oklch(0.130 0.02 260.0)",
      "--bg-sunken": "oklch(0.078 0.018 260.0)",
      "--bg-tile": "oklch(0.106 0.02 260.0)",
      "--bg-raised": "oklch(0.176 0.022 260.0)",
      "--bg-overlay": "oklch(0.208 0.024 260.0)",
      "--hover-surface": "oklch(0.227 0.024 260.0)",
      "--chrome-bg": "oklch(0.196 0.030 245.0)",
      "--text": "oklch(0.960 0.01 240.0)",
      "--text-muted": "oklch(0.740 0.015 245.0)",
      "--text-faint": "oklch(0.630 0.015 245.0)",
      "--accent": "oklch(0.870 0.17 215.0)",
      "--accent-strong": "oklch(0.930 0.13 215.0)",
      "--accent-tint": "oklch(0.870 0.17 215.0 / 0.12)",
      "--accent-glow": "oklch(0.870 0.17 215.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.16 215.0)",
      "--focus-ring": "oklch(0.600 0.15 215.0 / 0.50)",
      "--ok": "oklch(0.840 0.15 160.0)",
      "--warn": "oklch(0.870 0.16 80.0)",
      "--err": "oklch(0.740 0.2 25.0)",
      "--ok-tint": "oklch(0.840 0.15 160.0 / 0.12)",
      "--warn-tint": "oklch(0.870 0.16 80.0 / 0.12)",
      "--err-tint": "oklch(0.740 0.2 25.0 / 0.12)",
      "--line": "oklch(0.310 0.028 260.0)",
      "--line-strong": "oklch(0.406 0.030 260.0)",
      "--mark-ghost": "oklch(0.305 0.02 260.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.14 0.015 260 / 0.4), 0 24px 60px oklch(0.14 0.015 260 / 0.55)",
      "--overlay-scrim": "oklch(0.080 0.015 260.0 / 0.65)",
      "--btn-primary-fg": "oklch(0.150 0.02 260.0)",
      "--btn-primary-hover": "oklch(0.930 0.13 215.0)",
      "--selection-bg": "oklch(0.870 0.17 215.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.400 0.024 260.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.500 0.026 260.0 / 0.80)"
    },
    xterm: {
      "background": "#0c0e14",
      "foreground": "#e6f2f2",
      "cursor": "#37e6c8",
      "cursorAccent": "#0a0d10",
      "selectionBackground": "rgba(55, 230, 200, 0.25)",
      "black": "#12151c",
      "red": "#ff4d5e",
      "green": "#37e6c8",
      "yellow": "#f5d74a",
      "blue": "#4db8ff",
      "magenta": "#d46fff",
      "cyan": "#37e6c8",
      "white": "#e6f2f2",
      "brightBlack": "#7b8898",
      "brightRed": "#ff7080",
      "brightGreen": "#7df2de",
      "brightYellow": "#fce86e",
      "brightBlue": "#7ccaff",
      "brightMagenta": "#e49cff",
      "brightCyan": "#7df2de",
      "brightWhite": "#f0f6f6"
    },
  },
  {
    id: "paper",
    name: "Paper",
    tokens: {
      "--bg": "oklch(0.900 0.01 85.0)",
      "--bg-sunken": "oklch(0.812 0.012 85.0)",
      "--bg-tile": "oklch(0.836 0.012 85.0)",
      "--bg-raised": "oklch(0.935 0.01 85.0)",
      "--bg-overlay": "oklch(0.876 0.01 85.0)",
      "--hover-surface": "oklch(0.965 0.008 85.0)",
      "--chrome-bg": "oklch(0.920 0.010 85.0)",
      "--text": "oklch(0.220 0.02 60.0)",
      "--text-muted": "oklch(0.400 0.02 60.0)",
      "--text-faint": "oklch(0.470 0.02 60.0)",
      "--accent": "oklch(0.490 0.12 85.0)",
      "--accent-strong": "oklch(0.420 0.12 85.0)",
      "--accent-tint": "oklch(0.500 0.12 85.0 / 0.12)",
      "--accent-glow": "oklch(0.500 0.12 85.0 / 0.08)",
      "--focus-border": "oklch(0.460 0.11 85.0)",
      "--focus-ring": "oklch(0.380 0.1 85.0 / 0.50)",
      "--ok": "oklch(0.480 0.11 150.0)",
      "--warn": "oklch(0.500 0.13 45.0)",
      "--err": "oklch(0.520 0.17 25.0)",
      "--ok-tint": "oklch(0.480 0.11 150.0 / 0.14)",
      "--warn-tint": "oklch(0.500 0.13 45.0 / 0.14)",
      "--err-tint": "oklch(0.520 0.17 25.0 / 0.14)",
      "--line": "oklch(0.750 0.01 85.0)",
      "--line-strong": "oklch(0.654 0.012 85.0)",
      "--mark-ghost": "oklch(0.685 0.01 85.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.28 0.02 60 / 0.18), 0 24px 60px oklch(0.28 0.02 60 / 0.24)",
      "--overlay-scrim": "oklch(0.250 0.02 60.0 / 0.40)",
      "--btn-primary-fg": "oklch(0.970 0.01 90.0)",
      "--btn-primary-hover": "oklch(0.420 0.12 85.0)",
      "--selection-bg": "oklch(0.500 0.12 85.0 / 0.30)",
      "--scrollbar-thumb": "oklch(0.660 0.012 85.0 / 0.90)",
      "--scrollbar-thumb-hover": "oklch(0.580 0.013 85.0 / 0.90)"
    },
    xterm: {
      "background": "#d8d5cb",
      "foreground": "#2b2821",
      "cursor": "#8a6d2f",
      "cursorAccent": "#efece1",
      "selectionBackground": "rgba(138, 109, 47, 0.25)",
      "black": "#2b2821",
      "red": "#a03a35",
      "green": "#4a7233",
      "yellow": "#8a6d2f",
      "blue": "#3a5c82",
      "magenta": "#7a4a72",
      "cyan": "#2f6e6a",
      "white": "#efece1",
      "brightBlack": "#55503f",
      "brightRed": "#9c3834",
      "brightGreen": "#3d6226",
      "brightYellow": "#6f5721",
      "brightBlue": "#365c84",
      "brightMagenta": "#7a4a72",
      "brightCyan": "#27605c",
      "brightWhite": "#f7f4ea"
    },
  },
  {
    id: "ember",
    name: "Ember",
    tokens: {
      "--bg": "oklch(0.160 0.012 30.0)",
      "--bg-sunken": "oklch(0.108 0.011 30.0)",
      "--bg-tile": "oklch(0.136 0.012 30.0)",
      "--bg-raised": "oklch(0.206 0.014 30.0)",
      "--bg-overlay": "oklch(0.238 0.014 30.0)",
      "--hover-surface": "oklch(0.257 0.014 30.0)",
      "--chrome-bg": "oklch(0.222 0.014 30.0)",
      "--text": "oklch(0.950 0.01 70.0)",
      "--text-muted": "oklch(0.740 0.02 55.0)",
      "--text-faint": "oklch(0.630 0.02 55.0)",
      "--accent": "oklch(0.800 0.15 22.0)",
      "--accent-strong": "oklch(0.870 0.13 22.0)",
      "--accent-tint": "oklch(0.800 0.15 22.0 / 0.12)",
      "--accent-glow": "oklch(0.800 0.15 22.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.14 22.0)",
      "--focus-ring": "oklch(0.600 0.13 22.0 / 0.50)",
      "--ok": "oklch(0.800 0.14 145.0)",
      "--warn": "oklch(0.840 0.13 85.0)",
      "--err": "oklch(0.740 0.17 345.0)",
      "--ok-tint": "oklch(0.800 0.14 145.0 / 0.12)",
      "--warn-tint": "oklch(0.840 0.13 85.0 / 0.12)",
      "--err-tint": "oklch(0.740 0.17 345.0 / 0.12)",
      "--line": "oklch(0.340 0.016 30.0)",
      "--line-strong": "oklch(0.436 0.017 30.0)",
      "--mark-ghost": "oklch(0.335 0.015 30.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.17 0.01 30 / 0.35), 0 24px 60px oklch(0.17 0.01 30 / 0.5)",
      "--overlay-scrim": "oklch(0.110 0.008 30.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.02 30.0)",
      "--btn-primary-hover": "oklch(0.870 0.13 22.0)",
      "--selection-bg": "oklch(0.800 0.15 22.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.430 0.017 30.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.530 0.018 30.0 / 0.80)"
    },
    xterm: {
      "background": "#14100d",
      "foreground": "#f0e6d8",
      "cursor": "#e8875a",
      "cursorAccent": "#1c120c",
      "selectionBackground": "rgba(232, 135, 90, 0.25)",
      "black": "#1c1812",
      "red": "#e0605a",
      "green": "#9cae55",
      "yellow": "#d4a45a",
      "blue": "#7fa0c9",
      "magenta": "#c79ac7",
      "cyan": "#5fb0b0",
      "white": "#f0e6d8",
      "brightBlack": "#837c6e",
      "brightRed": "#f0837c",
      "brightGreen": "#b6c878",
      "brightYellow": "#e8bd82",
      "brightBlue": "#9dbfe0",
      "brightMagenta": "#dbb2db",
      "brightCyan": "#8cd0d0",
      "brightWhite": "#f7f3e8"
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    tokens: {
      "--bg": "oklch(0.150 0.012 250.0)",
      "--bg-sunken": "oklch(0.098 0.01 250.0)",
      "--bg-tile": "oklch(0.126 0.011 250.0)",
      "--bg-raised": "oklch(0.196 0.013 250.0)",
      "--bg-overlay": "oklch(0.228 0.014 250.0)",
      "--hover-surface": "oklch(0.247 0.014 250.0)",
      "--chrome-bg": "oklch(0.212 0.013 250.0)",
      "--text": "oklch(0.960 0.006 95.0)",
      "--text-muted": "oklch(0.740 0.012 250.0)",
      "--text-faint": "oklch(0.630 0.011 250.0)",
      "--accent": "oklch(0.800 0.13 250.0)",
      "--accent-strong": "oklch(0.870 0.11 250.0)",
      "--accent-tint": "oklch(0.800 0.13 250.0 / 0.12)",
      "--accent-glow": "oklch(0.800 0.13 250.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.12 250.0)",
      "--focus-ring": "oklch(0.600 0.11 250.0 / 0.50)",
      "--ok": "oklch(0.800 0.15 160.0)",
      "--warn": "oklch(0.850 0.15 85.0)",
      "--err": "oklch(0.720 0.19 25.0)",
      "--ok-tint": "oklch(0.800 0.15 160.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.15 85.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.19 25.0 / 0.12)",
      "--line": "oklch(0.330 0.014 250.0)",
      "--line-strong": "oklch(0.426 0.015 250.0)",
      "--mark-ghost": "oklch(0.315 0.015 250.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.01 250 / 0.35), 0 24px 60px oklch(0.16 0.01 250 / 0.5)",
      "--overlay-scrim": "oklch(0.100 0.008 250.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.160 0.02 250.0)",
      "--btn-primary-hover": "oklch(0.870 0.11 250.0)",
      "--selection-bg": "oklch(0.800 0.13 250.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.015 250.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.016 250.0 / 0.80)"
    },
    xterm: {
      "background": "#0e1116",
      "foreground": "#e8eef2",
      "cursor": "#5ab4e8",
      "cursorAccent": "#0e1419",
      "selectionBackground": "rgba(90, 180, 232, 0.25)",
      "black": "#12161c",
      "red": "#ff6b6b",
      "green": "#4ecb8e",
      "yellow": "#f5c542",
      "blue": "#7aa2f7",
      "magenta": "#d2a5ff",
      "cyan": "#56c8d8",
      "white": "#e8eef2",
      "brightBlack": "#7b828c",
      "brightRed": "#ff8f8f",
      "brightGreen": "#7ee2ad",
      "brightYellow": "#f7d97a",
      "brightBlue": "#9db9ff",
      "brightMagenta": "#dfc0ff",
      "brightCyan": "#8adce8",
      "brightWhite": "#f0f4f6"
    },
  },
  {
    id: "violet",
    name: "Violet",
    tokens: {
      "--bg": "oklch(0.150 0.014 285.0)",
      "--bg-sunken": "oklch(0.098 0.012 285.0)",
      "--bg-tile": "oklch(0.126 0.013 285.0)",
      "--bg-raised": "oklch(0.196 0.015 285.0)",
      "--bg-overlay": "oklch(0.228 0.016 285.0)",
      "--hover-surface": "oklch(0.247 0.016 285.0)",
      "--chrome-bg": "oklch(0.212 0.015 285.0)",
      "--text": "oklch(0.960 0.008 290.0)",
      "--text-muted": "oklch(0.740 0.014 285.0)",
      "--text-faint": "oklch(0.630 0.013 285.0)",
      "--accent": "oklch(0.800 0.13 295.0)",
      "--accent-strong": "oklch(0.870 0.11 295.0)",
      "--accent-tint": "oklch(0.800 0.13 295.0 / 0.12)",
      "--accent-glow": "oklch(0.800 0.13 295.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.12 295.0)",
      "--focus-ring": "oklch(0.600 0.11 295.0 / 0.50)",
      "--ok": "oklch(0.800 0.15 155.0)",
      "--warn": "oklch(0.850 0.15 85.0)",
      "--err": "oklch(0.720 0.19 25.0)",
      "--ok-tint": "oklch(0.800 0.15 155.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.15 85.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.19 25.0 / 0.12)",
      "--line": "oklch(0.330 0.016 285.0)",
      "--line-strong": "oklch(0.426 0.017 285.0)",
      "--mark-ghost": "oklch(0.315 0.015 285.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.012 285 / 0.35), 0 24px 60px oklch(0.16 0.012 285 / 0.5)",
      "--overlay-scrim": "oklch(0.100 0.01 285.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.160 0.02 285.0)",
      "--btn-primary-hover": "oklch(0.870 0.11 295.0)",
      "--selection-bg": "oklch(0.800 0.13 295.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.017 285.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.018 285.0 / 0.80)"
    },
    xterm: {
      "background": "#110e16",
      "foreground": "#ece8f2",
      "cursor": "#b48ae8",
      "cursorAccent": "#151020",
      "selectionBackground": "rgba(180, 138, 232, 0.25)",
      "black": "#171220",
      "red": "#ff6b6b",
      "green": "#4ecb8e",
      "yellow": "#f5c542",
      "blue": "#9d7af7",
      "magenta": "#d2a5ff",
      "cyan": "#56c8d8",
      "white": "#ece8f2",
      "brightBlack": "#837b90",
      "brightRed": "#ff8f8f",
      "brightGreen": "#7ee2ad",
      "brightYellow": "#f7d97a",
      "brightBlue": "#b49dff",
      "brightMagenta": "#e0c0ff",
      "brightCyan": "#8adce8",
      "brightWhite": "#f2eef6"
    },
  },
  {
    id: "slate",
    name: "Slate",
    tokens: {
      "--bg": "oklch(0.150 0.008 255.0)",
      "--bg-sunken": "oklch(0.098 0.007 255.0)",
      "--bg-tile": "oklch(0.126 0.008 255.0)",
      "--bg-raised": "oklch(0.196 0.009 255.0)",
      "--bg-overlay": "oklch(0.228 0.01 255.0)",
      "--hover-surface": "oklch(0.247 0.01 255.0)",
      "--chrome-bg": "oklch(0.212 0.009 255.0)",
      "--text": "oklch(0.960 0.005 95.0)",
      "--text-muted": "oklch(0.740 0.008 255.0)",
      "--text-faint": "oklch(0.630 0.008 255.0)",
      "--accent": "oklch(0.800 0.08 230.0)",
      "--accent-strong": "oklch(0.870 0.07 230.0)",
      "--accent-tint": "oklch(0.800 0.08 230.0 / 0.12)",
      "--accent-glow": "oklch(0.800 0.08 230.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.08 230.0)",
      "--focus-ring": "oklch(0.600 0.07 230.0 / 0.50)",
      "--ok": "oklch(0.800 0.12 150.0)",
      "--warn": "oklch(0.850 0.12 80.0)",
      "--err": "oklch(0.720 0.15 20.0)",
      "--ok-tint": "oklch(0.800 0.12 150.0 / 0.12)",
      "--warn-tint": "oklch(0.850 0.12 80.0 / 0.12)",
      "--err-tint": "oklch(0.720 0.15 20.0 / 0.12)",
      "--line": "oklch(0.330 0.009 255.0)",
      "--line-strong": "oklch(0.426 0.01 255.0)",
      "--mark-ghost": "oklch(0.315 0.008 255.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.16 0.008 255 / 0.35), 0 24px 60px oklch(0.16 0.008 255 / 0.5)",
      "--overlay-scrim": "oklch(0.100 0.006 255.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.160 0.015 230.0)",
      "--btn-primary-hover": "oklch(0.870 0.07 230.0)",
      "--selection-bg": "oklch(0.800 0.08 230.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.420 0.01 255.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.520 0.011 255.0 / 0.80)"
    },
    xterm: {
      "background": "#101114",
      "foreground": "#e6e8ec",
      "cursor": "#8fa8c8",
      "cursorAccent": "#141619",
      "selectionBackground": "rgba(143, 168, 200, 0.25)",
      "black": "#14161a",
      "red": "#d96a6a",
      "green": "#7cb88e",
      "yellow": "#c9b06a",
      "blue": "#8fa8c8",
      "magenta": "#b49ac0",
      "cyan": "#74a8b4",
      "white": "#e6e8ec",
      "brightBlack": "#7a8089",
      "brightRed": "#e08080",
      "brightGreen": "#96cfa8",
      "brightYellow": "#d9c080",
      "brightBlue": "#a8c0dc",
      "brightMagenta": "#c8b0d4",
      "brightCyan": "#8cc0cc",
      "brightWhite": "#eef0f4"
    },
  },
  {
    id: "rose",
    name: "Rose",
    tokens: {
      "--bg": "oklch(0.160 0.014 340.0)",
      "--bg-sunken": "oklch(0.108 0.013 340.0)",
      "--bg-tile": "oklch(0.136 0.014 340.0)",
      "--bg-raised": "oklch(0.206 0.016 340.0)",
      "--bg-overlay": "oklch(0.238 0.016 340.0)",
      "--hover-surface": "oklch(0.257 0.016 340.0)",
      "--chrome-bg": "oklch(0.222 0.016 340.0)",
      "--text": "oklch(0.950 0.012 350.0)",
      "--text-muted": "oklch(0.740 0.02 340.0)",
      "--text-faint": "oklch(0.630 0.02 340.0)",
      "--accent": "oklch(0.800 0.13 350.0)",
      "--accent-strong": "oklch(0.870 0.11 350.0)",
      "--accent-tint": "oklch(0.800 0.13 350.0 / 0.12)",
      "--accent-glow": "oklch(0.800 0.13 350.0 / 0.08)",
      "--focus-border": "oklch(0.700 0.12 350.0)",
      "--focus-ring": "oklch(0.600 0.11 350.0 / 0.50)",
      "--ok": "oklch(0.800 0.14 150.0)",
      "--warn": "oklch(0.840 0.13 85.0)",
      "--err": "oklch(0.740 0.16 45.0)",
      "--ok-tint": "oklch(0.800 0.14 150.0 / 0.12)",
      "--warn-tint": "oklch(0.840 0.13 85.0 / 0.12)",
      "--err-tint": "oklch(0.740 0.16 45.0 / 0.12)",
      "--line": "oklch(0.340 0.016 340.0)",
      "--line-strong": "oklch(0.436 0.017 340.0)",
      "--mark-ghost": "oklch(0.335 0.015 340.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.17 0.012 340 / 0.35), 0 24px 60px oklch(0.17 0.012 340 / 0.5)",
      "--overlay-scrim": "oklch(0.110 0.01 340.0 / 0.60)",
      "--btn-primary-fg": "oklch(0.170 0.02 340.0)",
      "--btn-primary-hover": "oklch(0.870 0.11 350.0)",
      "--selection-bg": "oklch(0.800 0.13 350.0 / 0.28)",
      "--scrollbar-thumb": "oklch(0.430 0.017 340.0 / 0.80)",
      "--scrollbar-thumb-hover": "oklch(0.530 0.018 340.0 / 0.80)"
    },
    xterm: {
      "background": "#140f12",
      "foreground": "#f0e6ea",
      "cursor": "#d87a94",
      "cursorAccent": "#1a1114",
      "selectionBackground": "rgba(216, 122, 148, 0.25)",
      "black": "#1a1417",
      "red": "#e0606a",
      "green": "#9cae55",
      "yellow": "#d4a45a",
      "blue": "#7fa0c9",
      "magenta": "#c77aa0",
      "cyan": "#5fb0b0",
      "white": "#f0e6ea",
      "brightBlack": "#8d7a84",
      "brightRed": "#f0838c",
      "brightGreen": "#b6c878",
      "brightYellow": "#e8bd82",
      "brightBlue": "#9dbfe0",
      "brightMagenta": "#d88ab0",
      "brightCyan": "#8cd0d0",
      "brightWhite": "#f7f0f4"
    },
  },
  {
    id: "ivory",
    name: "Ivory",
    tokens: {
      "--bg": "oklch(0.900 0.012 70.0)",
      "--bg-sunken": "oklch(0.812 0.014 70.0)",
      "--bg-tile": "oklch(0.836 0.014 70.0)",
      "--bg-raised": "oklch(0.935 0.01 70.0)",
      "--bg-overlay": "oklch(0.876 0.012 70.0)",
      "--hover-surface": "oklch(0.965 0.008 70.0)",
      "--chrome-bg": "oklch(0.920 0.012 70.0)",
      "--text": "oklch(0.220 0.02 60.0)",
      "--text-muted": "oklch(0.400 0.02 60.0)",
      "--text-faint": "oklch(0.470 0.02 60.0)",
      "--accent": "oklch(0.490 0.12 55.0)",
      "--accent-strong": "oklch(0.420 0.12 55.0)",
      "--accent-tint": "oklch(0.490 0.12 55.0 / 0.14)",
      "--accent-glow": "oklch(0.490 0.12 55.0 / 0.08)",
      "--focus-border": "oklch(0.460 0.11 55.0)",
      "--focus-ring": "oklch(0.380 0.1 55.0 / 0.50)",
      "--ok": "oklch(0.480 0.11 150.0)",
      "--warn": "oklch(0.500 0.13 100.0)",
      "--err": "oklch(0.520 0.17 15.0)",
      "--ok-tint": "oklch(0.480 0.11 150.0 / 0.14)",
      "--warn-tint": "oklch(0.500 0.13 100.0 / 0.14)",
      "--err-tint": "oklch(0.520 0.17 15.0 / 0.14)",
      "--line": "oklch(0.750 0.012 70.0)",
      "--line-strong": "oklch(0.654 0.014 70.0)",
      "--mark-ghost": "oklch(0.685 0.012 70.0)",
      "--shadow-dialog": "0 1px 2px oklch(0.28 0.02 60 / 0.18), 0 24px 60px oklch(0.28 0.02 60 / 0.24)",
      "--overlay-scrim": "oklch(0.250 0.02 60.0 / 0.40)",
      "--btn-primary-fg": "oklch(0.970 0.01 90.0)",
      "--btn-primary-hover": "oklch(0.420 0.12 55.0)",
      "--selection-bg": "oklch(0.490 0.12 55.0 / 0.30)",
      "--scrollbar-thumb": "oklch(0.660 0.014 70.0 / 0.90)",
      "--scrollbar-thumb-hover": "oklch(0.580 0.015 70.0 / 0.90)"
    },
    xterm: {
      "background": "#e2ddd0",
      "foreground": "#2a251c",
      "cursor": "#9c7a35",
      "cursorAccent": "#f2ede0",
      "selectionBackground": "rgba(156, 122, 53, 0.25)",
      "black": "#2a251c",
      "red": "#a03a35",
      "green": "#5a7233",
      "yellow": "#846a2c",
      "blue": "#4a5c82",
      "magenta": "#8a5a72",
      "cyan": "#3f6e6a",
      "white": "#f2ede0",
      "brightBlack": "#55503f",
      "brightRed": "#9c3834",
      "brightGreen": "#4d6226",
      "brightYellow": "#68521e",
      "brightBlue": "#4a5c84",
      "brightMagenta": "#7d4f68",
      "brightCyan": "#37605c",
      "brightWhite": "#f7f4ea"
    },
  }
];

/* ------------------------------------------------------------------ *
 * Regional + category color derivation
 *
 * Each theme rotates five chrome-region hues and six file-category hues
 * around its accent hue on an exact 60° wheel. Perceptual safety against
 * the fixed status hues (ok/warn/err) is achieved by shifting a theme's
 * whole category wheel (CATEGORY_BASE_SHIFT, hand-curated) when a slot
 * would land perceptually on a status color, and by nudging lightness
 * per hue until the WCAG target holds (categories ≥ 4.5:1 — they color
 * file names — and regional anchors ≥ 3:1). tests/themes.test.ts enforces
 * the outcome with ΔE(oklab) rules.
 * ------------------------------------------------------------------ */

export const REGION_OFFSETS: Record<RegionId, number> = { explorer: 30, editor: 90, reviewer: 150, palette: 210, settings: 270 };
export const CATEGORY_OFFSETS: Record<CategoryId, number> = { folder: 15, code: 75, doc: 135, config: 195, style: 255, data: 315 };

/** Whole-wheel category shifts, hand-curated per theme to maximize the
 *  worst-case perceptual distance from the fixed status hues (ok/warn/err).
 *  Computed by exhaustive search over 15° steps; verified by the test suite
 *  (category-vs-status ΔE ≥ 0.06, roughly 3× the just-noticeable difference). */
const CATEGORY_BASE_SHIFT: Partial<Record<ThemeId, number>> = {
  sable: 30,
  midnight: 45,
  amber: 30,
  paper: 15,
  ember: 30,
  ocean: 30,
  violet: 45,
  slate: 45,
  rose: 15,
  ivory: 45,
};

const fmt = (l: number, c: number, h: number): string => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
const fmtSoft = (l: number, c: number, h: number): string => `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)} / 0.12)`;

/** Nudges lightness (up on dark themes, down on light ones) until the
 *  contrast target holds against the theme background. */
function adjustForContrast(l: number, c: number, h: number, bg: string, target: number, light: boolean): number {
  let L = l;
  for (let i = 0; i < 60; i += 1) {
    if (contrastOklch(fmt(L, c, h), bg) >= target) return L;
    const next = light ? L - 0.01 : L + 0.01;
    if ((light && next < 0.22) || (!light && next > 0.90)) return L;
    L = next;
  }
  return L;
}

export function deriveSurfaceColors(base: BaseTokens, id: ThemeId): SurfaceColors {
  const accent = oklchParts(base['--accent']);
  const light = oklchParts(base['--bg']).l >= 0.5;
  const regionC = Math.min(0.14, Math.max(0.10, accent.c + 0.02));
  const categoryC = Math.min(0.15, Math.max(0.12, accent.c + 0.04));
  const anchorL = light ? 0.46 : 0.72;
  const categoryL = light ? 0.42 : 0.74;
  const categoryShift = CATEGORY_BASE_SHIFT[id] ?? 0;

  const out: Record<string, string> = {};
  REGION_IDS.forEach((role) => {
    const h = ((accent.h + REGION_OFFSETS[role]) % 360 + 360) % 360;
    const L = adjustForContrast(anchorL, regionC, h, base['--bg'], 3, light);
    out[`--rgn-${role}`] = fmt(L, regionC, h);
    out[`--rgn-${role}-soft`] = fmtSoft(L, regionC, h);
  });
  CATEGORY_IDS.forEach((kind) => {
    const h = ((accent.h + CATEGORY_OFFSETS[kind] + categoryShift) % 360 + 360) % 360;
    const L = adjustForContrast(categoryL, categoryC, h, base['--bg'], 4.5, light);
    out[`--cat-${kind}`] = fmt(L, categoryC, h);
  });
  return out as SurfaceColors;
}

export const THEMES: readonly FraktoleTheme[] = BASE_THEMES.map((t) => ({
  ...t,
  tokens: { ...t.tokens, ...deriveSurfaceColors(t.tokens, t.id) },
}));

export function themeById(id: string | null | undefined): FraktoleTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** Applies a theme's tokens as CSS variables on the document root. */
export function applyTheme(id: string): void {
  const theme = themeById(id);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.id;
}
