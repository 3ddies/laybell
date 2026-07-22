import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
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
  // Until the user picks a theme themselves (no saved preference), follow the
  // PHONE's appearance — a first launch on an iPhone in light mode opens a
  // light Laybell. Read synchronously at mount, BEFORE the native override
  // below ever runs, so this is the genuine system scheme. Requires the
  // app.json `userInterfaceStyle: "automatic"` native unlock to report the
  // real value; on the older dark-locked binaries this reads 'dark' — exactly
  // the previous default — so shipping this over OTA changes nothing there.
  const [mode, setModeState] = useState<ThemeMode>(() => (Appearance.getColorScheme() === 'light' ? 'light' : 'dark'));

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((m) => {
      if (m === 'dark' || m === 'grey' || m === 'light') setModeState(m);
    }).catch(() => {});
  }, []);

  // Pin the NATIVE chrome (keyboard, alerts, system sheets) to the app's own
  // scheme. With 'automatic' unlocked those would otherwise follow the SYSTEM
  // and could mismatch a manually-picked in-app theme (light keyboard under a
  // dark app). Grey counts as dark.
  useEffect(() => {
    try { Appearance.setColorScheme(mode === 'light' ? 'light' : 'dark'); } catch {}
  }, [mode]);

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
