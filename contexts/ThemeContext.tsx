import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { THEMES, type ThemeMode, type ThemePalette } from '../constants/theme';

// App-wide display mode (Dark / Grey / Light). Persisted locally and applied live:
// converted screens read `colors` from here and rebuild their styles whenever the
// mode changes, so switching recolors them instantly.

const STORAGE_KEY = 'display_mode';

type ThemeContextValue = {
  mode: ThemeMode;
  colors: ThemePalette;
  setMode: (m: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  colors: THEMES.dark,
  setMode: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

// Build a StyleSheet from the active palette and memoize it per (factory,
// palette) MODULE-WIDE — not per component instance. Pass a module-level
// factory: `const styles = useThemedStyles(makeStyles)`. Per-instance useMemo
// meant every card mounted mid-scroll re-ran its entire ~100-entry sheet; now
// each sheet is built exactly once per theme, app-wide. (Inline factories
// still work — they just fall back to rebuild-per-render, same as before.)
const themedStylesCache = new WeakMap<(c: ThemePalette) => unknown, WeakMap<ThemePalette, unknown>>();
export function useThemedStyles<T>(factory: (c: ThemePalette) => T): T {
  const { colors } = useTheme();
  let perPalette = themedStylesCache.get(factory as (c: ThemePalette) => unknown);
  if (!perPalette) {
    perPalette = new WeakMap();
    themedStylesCache.set(factory as (c: ThemePalette) => unknown, perPalette);
  }
  let styles = perPalette.get(colors) as T | undefined;
  if (styles === undefined) {
    styles = factory(colors);
    perPalette.set(colors, styles);
  }
  return styles;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((m) => {
      if (m === 'dark' || m === 'grey' || m === 'light') setModeState(m);
    }).catch(() => {});
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ mode, colors: THEMES[mode], setMode }),
    [mode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
