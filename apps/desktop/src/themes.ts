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

export interface ThemeTokens {
  '--bg': string;
  '--bg-raised': string;
  '--bg-overlay': string;
  '--bg-tile': string;
  '--text': string;
  '--text-muted': string;
  '--text-faint': string;
  '--accent': string;
  '--focus-border': string;
  '--focus-ring': string;
  '--ok': string;
  '--warn': string;
  '--err': string;
  '--line': string;
  '--line-strong': string;
  '--accent-glow': string;
  '--accent-tint': string;
  '--mark-ghost': string;
  '--shadow-dialog': string;
  '--overlay-scrim': string;
  '--btn-primary-fg': string;
  '--btn-primary-hover': string;
}

export interface FraktoleTheme {
  id: ThemeId;
  name: string;
  tokens: ThemeTokens;
  xterm: XtermPalette;
}

export const DEFAULT_THEME: ThemeId = 'midnight';

export const THEMES: readonly FraktoleTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    tokens: {
      '--bg': 'oklch(0.15 0.012 255)',
      '--bg-raised': 'oklch(0.19 0.013 255)',
      '--bg-overlay': 'oklch(0.22 0.014 255)',
      '--bg-tile': 'oklch(0.13 0.011 255)',
      '--text': 'oklch(0.96 0.006 95)',
      '--text-muted': 'oklch(0.72 0.012 255)',
      '--text-faint': 'oklch(0.55 0.01 255)',
      '--accent': 'oklch(0.8 0.16 160)',
      '--focus-border': 'oklch(0.72 0.15 160)',
      '--focus-ring': 'oklch(0.6 0.14 160 / 0.5)',
      '--ok': 'oklch(0.8 0.16 160)',
      '--warn': 'oklch(0.87 0.16 85)',
      '--err': 'oklch(0.7 0.19 25)',
      '--line': 'oklch(0.28 0.014 255)',
      '--line-strong': 'oklch(0.36 0.015 255)',
      '--accent-glow': 'oklch(0.8 0.16 160 / 0.06)',
      '--accent-tint': 'oklch(0.8 0.16 160 / 0.12)',
      '--mark-ghost': 'oklch(0.3 0.015 255)',
      '--shadow-dialog': '0 1px 2px oklch(0 0 0 / 0.3), 0 24px 60px oklch(0 0 0 / 0.45)',
      '--overlay-scrim': 'oklch(0.1 0.008 255 / 0.6)',
      '--btn-primary-fg': 'oklch(0.16 0.02 160)',
      '--btn-primary-hover': 'oklch(0.85 0.15 160)',
    },
    xterm: {
      background: '#0e1014',
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
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'gold',
    name: 'Gold',
    tokens: {
      '--bg': 'oklch(0.16 0.012 75)',
      '--bg-raised': 'oklch(0.2 0.014 75)',
      '--bg-overlay': 'oklch(0.23 0.014 75)',
      '--bg-tile': 'oklch(0.14 0.012 75)',
      '--text': 'oklch(0.95 0.01 85)',
      '--text-muted': 'oklch(0.72 0.02 80)',
      '--text-faint': 'oklch(0.55 0.02 80)',
      '--accent': 'oklch(0.82 0.13 85)',
      '--focus-border': 'oklch(0.74 0.13 85)',
      '--focus-ring': 'oklch(0.62 0.12 85 / 0.5)',
      '--ok': 'oklch(0.82 0.13 85)',
      '--warn': 'oklch(0.86 0.15 80)',
      '--err': 'oklch(0.7 0.18 30)',
      '--line': 'oklch(0.3 0.015 75)',
      '--line-strong': 'oklch(0.38 0.016 75)',
      '--accent-glow': 'oklch(0.82 0.13 85 / 0.06)',
      '--accent-tint': 'oklch(0.82 0.13 85 / 0.12)',
      '--mark-ghost': 'oklch(0.32 0.015 75)',
      '--shadow-dialog': '0 1px 2px oklch(0 0 0 / 0.3), 0 24px 60px oklch(0 0 0 / 0.45)',
      '--overlay-scrim': 'oklch(0.11 0.008 75 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.02 75)',
      '--btn-primary-hover': 'oklch(0.87 0.12 85)',
    },
    xterm: {
      background: '#100f0c',
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
      brightWhite: '#fffaf0',
    },
  },
  {
    id: 'amber',
    name: 'Amber',
    tokens: {
      '--bg': 'oklch(0.15 0.02 55)',
      '--bg-raised': 'oklch(0.19 0.022 55)',
      '--bg-overlay': 'oklch(0.22 0.022 55)',
      '--bg-tile': 'oklch(0.13 0.02 55)',
      '--text': 'oklch(0.95 0.012 70)',
      '--text-muted': 'oklch(0.72 0.02 60)',
      '--text-faint': 'oklch(0.55 0.02 60)',
      '--accent': 'oklch(0.8 0.16 70)',
      '--focus-border': 'oklch(0.72 0.16 70)',
      '--focus-ring': 'oklch(0.6 0.15 70 / 0.5)',
      '--ok': 'oklch(0.8 0.16 70)',
      '--warn': 'oklch(0.85 0.17 80)',
      '--err': 'oklch(0.7 0.18 30)',
      '--line': 'oklch(0.29 0.02 55)',
      '--line-strong': 'oklch(0.37 0.022 55)',
      '--accent-glow': 'oklch(0.8 0.16 70 / 0.06)',
      '--accent-tint': 'oklch(0.8 0.16 70 / 0.12)',
      '--mark-ghost': 'oklch(0.31 0.02 55)',
      '--shadow-dialog': '0 1px 2px oklch(0 0 0 / 0.3), 0 24px 60px oklch(0 0 0 / 0.45)',
      '--overlay-scrim': 'oklch(0.1 0.015 55 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.03 55)',
      '--btn-primary-hover': 'oklch(0.85 0.15 70)',
    },
    xterm: {
      background: '#0f0d0a',
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
      brightBlack: '#84796b',
      brightRed: '#f0837c',
      brightGreen: '#c2ba72',
      brightYellow: '#f5bb66',
      brightBlue: '#a8bcd8',
      brightMagenta: '#dbb2ce',
      brightCyan: '#8cc8c0',
      brightWhite: '#fff8ec',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    tokens: {
      '--bg': 'oklch(0.15 0.012 150)',
      '--bg-raised': 'oklch(0.19 0.014 150)',
      '--bg-overlay': 'oklch(0.22 0.015 150)',
      '--bg-tile': 'oklch(0.13 0.011 150)',
      '--text': 'oklch(0.95 0.01 140)',
      '--text-muted': 'oklch(0.72 0.015 150)',
      '--text-faint': 'oklch(0.55 0.014 150)',
      '--accent': 'oklch(0.85 0.15 150)',
      '--focus-border': 'oklch(0.77 0.14 150)',
      '--focus-ring': 'oklch(0.65 0.13 150 / 0.5)',
      '--ok': 'oklch(0.85 0.15 150)',
      '--warn': 'oklch(0.86 0.16 95)',
      '--err': 'oklch(0.72 0.19 25)',
      '--line': 'oklch(0.29 0.014 150)',
      '--line-strong': 'oklch(0.37 0.015 150)',
      '--accent-glow': 'oklch(0.85 0.15 150 / 0.06)',
      '--accent-tint': 'oklch(0.85 0.15 150 / 0.12)',
      '--mark-ghost': 'oklch(0.32 0.014 150)',
      '--shadow-dialog': '0 1px 2px oklch(0 0 0 / 0.3), 0 24px 60px oklch(0 0 0 / 0.45)',
      '--overlay-scrim': 'oklch(0.1 0.01 150 / 0.6)',
      '--btn-primary-fg': 'oklch(0.17 0.02 150)',
      '--btn-primary-hover': 'oklch(0.9 0.13 150)',
    },
    xterm: {
      background: '#0e110e',
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
      brightWhite: '#fafff0',
    },
  },
  {
    id: 'neon',
    name: 'Neon',
    tokens: {
      '--bg': 'oklch(0.13 0.02 260)',
      '--bg-raised': 'oklch(0.17 0.022 260)',
      '--bg-overlay': 'oklch(0.2 0.024 260)',
      '--bg-tile': 'oklch(0.11 0.02 260)',
      '--text': 'oklch(0.96 0.01 240)',
      '--text-muted': 'oklch(0.72 0.015 245)',
      '--text-faint': 'oklch(0.55 0.015 245)',
      '--accent': 'oklch(0.85 0.18 210)',
      '--focus-border': 'oklch(0.68 0.2 25)',
      '--focus-ring': 'oklch(0.58 0.18 25 / 0.5)',
      '--ok': 'oklch(0.85 0.18 210)',
      '--warn': 'oklch(0.87 0.16 85)',
      '--err': 'oklch(0.72 0.2 25)',
      '--line': 'oklch(0.27 0.02 260)',
      '--line-strong': 'oklch(0.35 0.022 260)',
      '--accent-glow': 'oklch(0.85 0.18 210 / 0.06)',
      '--accent-tint': 'oklch(0.85 0.18 210 / 0.12)',
      '--mark-ghost': 'oklch(0.29 0.02 260)',
      '--shadow-dialog': '0 1px 2px oklch(0 0 0 / 0.4), 0 24px 60px oklch(0 0 0 / 0.55)',
      '--overlay-scrim': 'oklch(0.08 0.015 260 / 0.65)',
      '--btn-primary-fg': 'oklch(0.15 0.02 260)',
      '--btn-primary-hover': 'oklch(0.9 0.16 210)',
    },
    xterm: {
      background: '#0b0d12',
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
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    tokens: {
      '--bg': 'oklch(0.9 0.01 85)',
      '--bg-raised': 'oklch(0.93 0.01 85)',
      '--bg-overlay': 'oklch(0.87 0.01 85)',
      '--bg-tile': 'oklch(0.84 0.012 85)',
      '--text': 'oklch(0.22 0.02 60)',
      '--text-muted': 'oklch(0.4 0.02 60)',
      '--text-faint': 'oklch(0.5 0.02 60)',
      '--accent': 'oklch(0.55 0.12 80)',
      '--focus-border': 'oklch(0.5 0.12 80)',
      '--focus-ring': 'oklch(0.42 0.11 80 / 0.5)',
      '--ok': 'oklch(0.55 0.12 80)',
      '--warn': 'oklch(0.55 0.14 70)',
      '--err': 'oklch(0.55 0.17 30)',
      '--line': 'oklch(0.78 0.01 85)',
      '--line-strong': 'oklch(0.7 0.012 85)',
      '--accent-glow': 'oklch(0.55 0.12 80 / 0.08)',
      '--accent-tint': 'oklch(0.55 0.12 80 / 0.14)',
      '--mark-ghost': 'oklch(0.7 0.01 85)',
      '--shadow-dialog': '0 1px 2px oklch(0.2 0.02 60 / 0.15), 0 24px 60px oklch(0.2 0.02 60 / 0.2)',
      '--overlay-scrim': 'oklch(0.25 0.02 60 / 0.4)',
      '--btn-primary-fg': 'oklch(0.97 0.01 90)',
      '--btn-primary-hover': 'oklch(0.6 0.12 80)',
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
