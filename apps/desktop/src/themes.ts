export const THEME_IDS = ['midnight', 'gold', 'amber', 'forest', 'neon', 'paper'] as const;
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
 * Theme token contract. Every color a component can use lives here — a
 * component styles itself exclusively through these names. Rules enforced
 * by the test suite (tests/themes.test.ts + tests/token-coverage.test.ts):
 *
 *   - text levels are small-text safe (≥ 4.5:1 on every surface)
 *   - status hues are theme-tinted but ≥ 30° away from the accent
 *   - tints are the same color at ~12% alpha
 *   - shadows are hue-tinted near-black, never pure black
 *   - hairlines keep a perceptual lightness gap over the base
 */
export interface ThemeTokens {
  // surfaces — six levels from deepest well to overlay
  '--bg': string;
  '--bg-sunken': string;
  '--bg-tile': string;
  '--bg-raised': string;
  '--bg-overlay': string;
  '--hover-surface': string;
  '--active-surface': string;
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

export const DEFAULT_THEME: ThemeId = 'midnight';

/**
 * Hue wheels (accent / ok / warn / err) — the coherence rule: each theme
 * keeps its personality hue for the accent, and the status hues are tuned
 * to sit ≥ 30° away while carrying the theme's warmth. Neutrals carry the
 * theme's hue family (cool blue for midnight/neon, warm for gold/amber,
 * green for forest, warm paper).
 */
export const THEMES: readonly FraktoleTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    tokens: {
      '--bg': 'oklch(0.15 0.012 255)',
      '--bg-sunken': 'oklch(0.11 0.01 255)',
      '--bg-tile': 'oklch(0.13 0.011 255)',
      '--bg-raised': 'oklch(0.19 0.013 255)',
      '--bg-overlay': 'oklch(0.22 0.014 255)',
      '--hover-surface': 'oklch(0.235 0.014 255)',
      '--active-surface': 'oklch(0.26 0.015 255)',
      '--text': 'oklch(0.96 0.006 95)',
      '--text-muted': 'oklch(0.74 0.012 255)',
      '--text-faint': 'oklch(0.63 0.011 255)',
      '--accent': 'oklch(0.82 0.15 170)',
      '--accent-strong': 'oklch(0.88 0.13 170)',
      '--accent-tint': 'oklch(0.82 0.15 170 / 0.12)',
      '--accent-glow': 'oklch(0.82 0.15 170 / 0.06)',
      '--focus-border': 'oklch(0.72 0.14 170)',
      '--focus-ring': 'oklch(0.62 0.13 170 / 0.5)',
      '--ok': 'oklch(0.8 0.15 140)',
      '--warn': 'oklch(0.85 0.15 85)',
      '--err': 'oklch(0.72 0.19 22)',
      '--ok-tint': 'oklch(0.8 0.15 140 / 0.12)',
      '--warn-tint': 'oklch(0.85 0.15 85 / 0.12)',
      '--err-tint': 'oklch(0.72 0.19 22 / 0.12)',
      '--line': 'oklch(0.33 0.014 255)',
      '--line-strong': 'oklch(0.42 0.015 255)',
      '--mark-ghost': 'oklch(0.3 0.015 255)',
      '--shadow-dialog': '0 1px 2px oklch(0.16 0.01 255 / 0.35), 0 24px 60px oklch(0.16 0.01 255 / 0.5)',
      '--overlay-scrim': 'oklch(0.1 0.008 255 / 0.6)',
      '--btn-primary-fg': 'oklch(0.16 0.02 170)',
      '--btn-primary-hover': 'oklch(0.88 0.13 170)',
      '--selection-bg': 'oklch(0.82 0.15 170 / 0.28)',
      '--scrollbar-thumb': 'oklch(0.42 0.015 255 / 0.8)',
      '--scrollbar-thumb-hover': 'oklch(0.52 0.016 255 / 0.8)',
    },
    xterm: {
      background: '#101418',
      foreground: '#ece8df',
      cursor: '#4ecb8e',
      cursorAccent: '#171a20',
      selectionBackground: 'rgba(78, 203, 142, 0.25)',
      black: '#171a20',
      red: '#ff6b6b',
      green: '#4ecb8e',
      yellow: '#f5c542',
      blue: '#7aa2f7',
      magenta: '#d2a5ff',
      cyan: '#56c8d8',
      white: '#ece8df',
      brightBlack: '#7b828c',
      brightRed: '#ff8f8f',
      brightGreen: '#7ee2ad',
      brightYellow: '#f7d97a',
      brightBlue: '#9db9ff',
      brightMagenta: '#dfc0ff',
      brightCyan: '#8adce8',
      brightWhite: '#f2f5f2',
    },
  },
  {
    id: 'gold',
    name: 'Gold',
    tokens: {
      '--bg': 'oklch(0.16 0.012 75)',
      '--bg-sunken': 'oklch(0.12 0.011 75)',
      '--bg-tile': 'oklch(0.14 0.012 75)',
      '--bg-raised': 'oklch(0.2 0.014 75)',
      '--bg-overlay': 'oklch(0.23 0.014 75)',
      '--hover-surface': 'oklch(0.245 0.014 75)',
      '--active-surface': 'oklch(0.27 0.015 75)',
      '--text': 'oklch(0.95 0.01 85)',
      '--text-muted': 'oklch(0.74 0.02 80)',
      '--text-faint': 'oklch(0.63 0.02 80)',
      '--accent': 'oklch(0.83 0.13 85)',
      '--accent-strong': 'oklch(0.89 0.11 85)',
      '--accent-tint': 'oklch(0.83 0.13 85 / 0.12)',
      '--accent-glow': 'oklch(0.83 0.13 85 / 0.06)',
      '--focus-border': 'oklch(0.73 0.12 85)',
      '--focus-ring': 'oklch(0.63 0.11 85 / 0.5)',
      '--ok': 'oklch(0.8 0.14 145)',
      '--warn': 'oklch(0.84 0.13 55)',
      '--err': 'oklch(0.72 0.18 25)',
      '--ok-tint': 'oklch(0.8 0.14 145 / 0.12)',
      '--warn-tint': 'oklch(0.84 0.13 55 / 0.12)',
      '--err-tint': 'oklch(0.72 0.18 25 / 0.12)',
      '--line': 'oklch(0.34 0.016 75)',
      '--line-strong': 'oklch(0.43 0.017 75)',
      '--mark-ghost': 'oklch(0.32 0.015 75)',
      '--shadow-dialog': '0 1px 2px oklch(0.17 0.01 75 / 0.35), 0 24px 60px oklch(0.17 0.01 75 / 0.5)',
      '--overlay-scrim': 'oklch(0.11 0.008 75 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.02 75)',
      '--btn-primary-hover': 'oklch(0.89 0.11 85)',
      '--selection-bg': 'oklch(0.83 0.13 85 / 0.28)',
      '--scrollbar-thumb': 'oklch(0.43 0.017 75 / 0.8)',
      '--scrollbar-thumb-hover': 'oklch(0.53 0.018 75 / 0.8)',
    },
    xterm: {
      background: '#131209',
      foreground: '#f0e9d6',
      cursor: '#d4b45a',
      cursorAccent: '#191611',
      selectionBackground: 'rgba(212, 180, 90, 0.25)',
      black: '#1a1813',
      red: '#e0605a',
      green: '#9cae55',
      yellow: '#d4b45a',
      blue: '#7fa0c9',
      magenta: '#c79ac7',
      cyan: '#5fb0b0',
      white: '#f0e9d6',
      brightBlack: '#837c6e',
      brightRed: '#f0837c',
      brightGreen: '#b6c878',
      brightYellow: '#e8cd82',
      brightBlue: '#9dbfe0',
      brightMagenta: '#dbb2db',
      brightCyan: '#8cd0d0',
      brightWhite: '#f7f3e8',
    },
  },
  {
    id: 'amber',
    name: 'Amber',
    tokens: {
      '--bg': 'oklch(0.15 0.02 55)',
      '--bg-sunken': 'oklch(0.11 0.019 55)',
      '--bg-tile': 'oklch(0.13 0.02 55)',
      '--bg-raised': 'oklch(0.19 0.022 55)',
      '--bg-overlay': 'oklch(0.22 0.022 55)',
      '--hover-surface': 'oklch(0.235 0.022 55)',
      '--active-surface': 'oklch(0.26 0.023 55)',
      '--text': 'oklch(0.95 0.012 70)',
      '--text-muted': 'oklch(0.74 0.02 60)',
      '--text-faint': 'oklch(0.63 0.02 60)',
      '--accent': 'oklch(0.82 0.16 75)',
      '--accent-strong': 'oklch(0.88 0.14 75)',
      '--accent-tint': 'oklch(0.82 0.16 75 / 0.12)',
      '--accent-glow': 'oklch(0.82 0.16 75 / 0.06)',
      '--focus-border': 'oklch(0.72 0.15 75)',
      '--focus-ring': 'oklch(0.62 0.14 75 / 0.5)',
      '--ok': 'oklch(0.8 0.15 140)',
      '--warn': 'oklch(0.84 0.15 105)',
      '--err': 'oklch(0.72 0.18 25)',
      '--ok-tint': 'oklch(0.8 0.15 140 / 0.12)',
      '--warn-tint': 'oklch(0.84 0.15 105 / 0.12)',
      '--err-tint': 'oklch(0.72 0.18 25 / 0.12)',
      '--line': 'oklch(0.33 0.02 55)',
      '--line-strong': 'oklch(0.42 0.022 55)',
      '--mark-ghost': 'oklch(0.31 0.02 55)',
      '--shadow-dialog': '0 1px 2px oklch(0.16 0.02 55 / 0.35), 0 24px 60px oklch(0.16 0.02 55 / 0.5)',
      '--overlay-scrim': 'oklch(0.1 0.015 55 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.03 55)',
      '--btn-primary-hover': 'oklch(0.88 0.14 75)',
      '--selection-bg': 'oklch(0.82 0.16 75 / 0.28)',
      '--scrollbar-thumb': 'oklch(0.42 0.022 55 / 0.8)',
      '--scrollbar-thumb-hover': 'oklch(0.52 0.023 55 / 0.8)',
    },
    xterm: {
      background: '#110f0b',
      foreground: '#f2e6d2',
      cursor: '#e8a33d',
      cursorAccent: '#1a140c',
      selectionBackground: 'rgba(232, 163, 61, 0.25)',
      black: '#1c160f',
      red: '#e0605a',
      green: '#a8a04e',
      yellow: '#e8a33d',
      blue: '#8a9fc0',
      magenta: '#c49ab8',
      cyan: '#5ca8a0',
      white: '#f2e6d2',
      brightBlack: '#8d8574',
      brightRed: '#f0837c',
      brightGreen: '#c2ba72',
      brightYellow: '#f5bb66',
      brightBlue: '#a8bcd8',
      brightMagenta: '#dbb2ce',
      brightCyan: '#8cc8c0',
      brightWhite: '#f8f2e6',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    tokens: {
      '--bg': 'oklch(0.15 0.012 150)',
      '--bg-sunken': 'oklch(0.11 0.011 150)',
      '--bg-tile': 'oklch(0.13 0.011 150)',
      '--bg-raised': 'oklch(0.19 0.014 150)',
      '--bg-overlay': 'oklch(0.22 0.015 150)',
      '--hover-surface': 'oklch(0.235 0.014 150)',
      '--active-surface': 'oklch(0.26 0.015 150)',
      '--text': 'oklch(0.95 0.01 140)',
      '--text-muted': 'oklch(0.74 0.015 150)',
      '--text-faint': 'oklch(0.63 0.014 150)',
      '--accent': 'oklch(0.86 0.15 160)',
      '--accent-strong': 'oklch(0.92 0.12 160)',
      '--accent-tint': 'oklch(0.86 0.15 160 / 0.12)',
      '--accent-glow': 'oklch(0.86 0.15 160 / 0.06)',
      '--focus-border': 'oklch(0.76 0.13 160)',
      '--focus-ring': 'oklch(0.66 0.12 160 / 0.5)',
      '--ok': 'oklch(0.82 0.14 130)',
      '--warn': 'oklch(0.85 0.15 85)',
      '--err': 'oklch(0.73 0.19 25)',
      '--ok-tint': 'oklch(0.82 0.14 130 / 0.12)',
      '--warn-tint': 'oklch(0.85 0.15 85 / 0.12)',
      '--err-tint': 'oklch(0.73 0.19 25 / 0.12)',
      '--line': 'oklch(0.33 0.015 150)',
      '--line-strong': 'oklch(0.42 0.016 150)',
      '--mark-ghost': 'oklch(0.32 0.014 150)',
      '--shadow-dialog': '0 1px 2px oklch(0.16 0.01 150 / 0.35), 0 24px 60px oklch(0.16 0.01 150 / 0.5)',
      '--overlay-scrim': 'oklch(0.1 0.01 150 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.02 150)',
      '--btn-primary-hover': 'oklch(0.92 0.12 160)',
      '--selection-bg': 'oklch(0.86 0.15 160 / 0.28)',
      '--scrollbar-thumb': 'oklch(0.42 0.016 150 / 0.8)',
      '--scrollbar-thumb-hover': 'oklch(0.52 0.017 150 / 0.8)',
    },
    xterm: {
      background: '#0f120e',
      foreground: '#e8ecdf',
      cursor: '#9fe0a8',
      cursorAccent: '#13180f',
      selectionBackground: 'rgba(159, 224, 168, 0.25)',
      black: '#181a14',
      red: '#e0605a',
      green: '#9fe0a8',
      yellow: '#d4d05e',
      blue: '#8aa8c4',
      magenta: '#c4a0c0',
      cyan: '#64b8a8',
      white: '#e8ecdf',
      brightBlack: '#7c8579',
      brightRed: '#f0837c',
      brightGreen: '#c2f0c8',
      brightYellow: '#e8e48a',
      brightBlue: '#aac6dc',
      brightMagenta: '#dcb8d8',
      brightCyan: '#8cd8c8',
      brightWhite: '#f3f6ee',
    },
  },
  {
    id: 'neon',
    name: 'Neon',
    tokens: {
      '--bg': 'oklch(0.13 0.02 260)',
      '--bg-sunken': 'oklch(0.09 0.018 260)',
      '--bg-tile': 'oklch(0.11 0.02 260)',
      '--bg-raised': 'oklch(0.17 0.022 260)',
      '--bg-overlay': 'oklch(0.2 0.024 260)',
      '--hover-surface': 'oklch(0.215 0.024 260)',
      '--active-surface': 'oklch(0.24 0.025 260)',
      '--text': 'oklch(0.96 0.01 240)',
      '--text-muted': 'oklch(0.74 0.015 245)',
      '--text-faint': 'oklch(0.63 0.015 245)',
      '--accent': 'oklch(0.87 0.17 215)',
      '--accent-strong': 'oklch(0.93 0.13 215)',
      '--accent-tint': 'oklch(0.87 0.17 215 / 0.12)',
      '--accent-glow': 'oklch(0.87 0.17 215 / 0.06)',
      '--focus-border': 'oklch(0.7 0.16 215)',
      '--focus-ring': 'oklch(0.6 0.15 215 / 0.5)',
      '--ok': 'oklch(0.84 0.15 160)',
      '--warn': 'oklch(0.87 0.16 80)',
      '--err': 'oklch(0.74 0.2 25)',
      '--ok-tint': 'oklch(0.84 0.15 160 / 0.12)',
      '--warn-tint': 'oklch(0.87 0.16 80 / 0.12)',
      '--err-tint': 'oklch(0.74 0.2 25 / 0.12)',
      '--line': 'oklch(0.31 0.022 260)',
      '--line-strong': 'oklch(0.4 0.024 260)',
      '--mark-ghost': 'oklch(0.29 0.02 260)',
      '--shadow-dialog': '0 1px 2px oklch(0.14 0.015 260 / 0.4), 0 24px 60px oklch(0.14 0.015 260 / 0.55)',
      '--overlay-scrim': 'oklch(0.08 0.015 260 / 0.65)',
      '--btn-primary-fg': 'oklch(0.15 0.02 260)',
      '--btn-primary-hover': 'oklch(0.93 0.13 215)',
      '--selection-bg': 'oklch(0.87 0.17 215 / 0.28)',
      '--scrollbar-thumb': 'oklch(0.4 0.024 260 / 0.8)',
      '--scrollbar-thumb-hover': 'oklch(0.5 0.026 260 / 0.8)',
    },
    xterm: {
      background: '#0c0e14',
      foreground: '#e6f2f2',
      cursor: '#37e6c8',
      cursorAccent: '#0a0d10',
      selectionBackground: 'rgba(55, 230, 200, 0.25)',
      black: '#12151c',
      red: '#ff4d5e',
      green: '#37e6c8',
      yellow: '#f5d74a',
      blue: '#4db8ff',
      magenta: '#d46fff',
      cyan: '#37e6c8',
      white: '#e6f2f2',
      brightBlack: '#7b8898',
      brightRed: '#ff7080',
      brightGreen: '#7df2de',
      brightYellow: '#fce86e',
      brightBlue: '#7ccaff',
      brightMagenta: '#e49cff',
      brightCyan: '#7df2de',
      brightWhite: '#f0f6f6',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    tokens: {
      '--bg': 'oklch(0.9 0.01 85)',
      '--bg-sunken': 'oklch(0.82 0.012 85)',
      '--bg-tile': 'oklch(0.84 0.012 85)',
      '--bg-raised': 'oklch(0.93 0.01 85)',
      '--bg-overlay': 'oklch(0.87 0.01 85)',
      '--hover-surface': 'oklch(0.955 0.008 85)',
      '--active-surface': 'oklch(0.98 0.005 85)',
      '--text': 'oklch(0.22 0.02 60)',
      '--text-muted': 'oklch(0.4 0.02 60)',
      '--text-faint': 'oklch(0.47 0.02 60)',
      '--accent': 'oklch(0.49 0.12 85)',
      '--accent-strong': 'oklch(0.42 0.12 85)',
      '--accent-tint': 'oklch(0.5 0.12 85 / 0.12)',
      '--accent-glow': 'oklch(0.5 0.12 85 / 0.06)',
      '--focus-border': 'oklch(0.46 0.11 85)',
      '--focus-ring': 'oklch(0.38 0.1 85 / 0.5)',
      '--ok': 'oklch(0.48 0.11 150)',
      '--warn': 'oklch(0.5 0.13 55)',
      '--err': 'oklch(0.52 0.17 25)',
      '--ok-tint': 'oklch(0.48 0.11 150 / 0.14)',
      '--warn-tint': 'oklch(0.5 0.13 55 / 0.14)',
      '--err-tint': 'oklch(0.52 0.17 25 / 0.14)',
      '--line': 'oklch(0.75 0.01 85)',
      '--line-strong': 'oklch(0.66 0.012 85)',
      '--mark-ghost': 'oklch(0.7 0.01 85)',
      '--shadow-dialog': '0 1px 2px oklch(0.28 0.02 60 / 0.18), 0 24px 60px oklch(0.28 0.02 60 / 0.24)',
      '--overlay-scrim': 'oklch(0.25 0.02 60 / 0.4)',
      '--btn-primary-fg': 'oklch(0.97 0.01 90)',
      '--btn-primary-hover': 'oklch(0.42 0.12 85)',
      '--selection-bg': 'oklch(0.5 0.12 85 / 0.3)',
      '--scrollbar-thumb': 'oklch(0.66 0.012 85 / 0.9)',
      '--scrollbar-thumb-hover': 'oklch(0.58 0.013 85 / 0.9)',
    },
    xterm: {
      background: '#d8d5cb',
      foreground: '#2b2821',
      cursor: '#8a6d2f',
      cursorAccent: '#efece1',
      selectionBackground: 'rgba(138, 109, 47, 0.25)',
      black: '#2b2821',
      red: '#a03a35',
      green: '#4a7233',
      yellow: '#8a6d2f',
      blue: '#3a5c82',
      magenta: '#7a4a72',
      cyan: '#2f6e6a',
      white: '#efece1',
      brightBlack: '#55503f',
      brightRed: '#9c3834',
      brightGreen: '#3d6226',
      brightYellow: '#6f5721',
      brightBlue: '#365c84',
      brightMagenta: '#7a4a72',
      brightCyan: '#27605c',
      brightWhite: '#f7f4ea',
    },
  },
];

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
