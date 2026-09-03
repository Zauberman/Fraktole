import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { DEFAULT_THEME, themeById, type ThemeId } from './themes.js';

interface ThemeContextValue {
  themeId: ThemeId;
  setTheme(id: ThemeId): void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeId: DEFAULT_THEME,
  setTheme: () => undefined,
});

export function ThemeProvider(props: { themeId: ThemeId; setTheme: (id: ThemeId) => void; children: React.ReactNode }): React.JSX.Element {
  const { themeId, setTheme, children } = props;
  // stable identity: every App render must not re-render all consumers
  const setThemeStable = useCallback(setTheme, [setTheme]);
  const value = useMemo(() => ({ themeId, setTheme: setThemeStable }), [themeId, setThemeStable]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** The xterm palette for the current theme. Memoized on themeId: a stable
 *  object identity is required — terminals key their theme effect off it,
 *  and an unstable identity re-applies the theme (and re-emits its OSC
 *  palette) on every parent re-render. */
export function useXtermPalette(): ReturnType<typeof themeById>['xterm'] {
  const { themeId } = useTheme();
  return useMemo(() => themeById(themeId).xterm, [themeId]);
}
