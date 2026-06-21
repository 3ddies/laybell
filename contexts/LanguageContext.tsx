import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translate, isLang, DEFAULT_LANG, setActiveLang, type Lang } from '../lib/i18n';

// App-wide language. Persisted locally (AsyncStorage) and applied live: every
// screen that reads strings via `t()` re-renders when the language changes, so
// switching it (onboarding or Settings) updates the UI instantly. Defaults to
// English; new users pick a language during account creation, and anyone can
// change it in Settings. Mirrors the ThemeContext pattern.

const STORAGE_KEY = 'app_language';

type LanguageContextValue = {
  lang: Lang;
  setLang: (l: Lang) => void;
  // The translator bound to the current language.
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<LanguageContextValue>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => key,
});

export function useTranslation() {
  return useContext(LanguageContext);
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Default to English; a stored choice (loaded below) overrides it.
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (isLang(stored)) setLangState(stored);
    }).catch(() => {});
  }, []);

  // Keep the module-level singleton (used by timeAgo, countLabel, and the data-
  // list label helpers — all outside the React tree) in sync with the active lang.
  useEffect(() => { setActiveLang(lang); }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {});
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, setLang],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
