import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translate, isLang, DEFAULT_LANG, setActiveLang, type Lang } from '../lib/i18n';

// App-wide language. Persisted locally (AsyncStorage) and applied live: every
// screen that reads strings via `t()` re-renders when the language changes, so
// switching it (onboarding or Settings) updates the UI instantly. Defaults to
// English; new users pick a language during account creation, and anyone can
// change it in Settings. Mirrors the ThemeContext pattern.

const STORAGE_KEY = 'app_language';
const AUTO_TRANSLATE_KEY = 'auto_translate';

type LanguageContextValue = {
  lang: Lang;
  setLang: (l: Lang) => void;
  // The translator bound to the current language.
  t: (key: string, vars?: Record<string, string | number>) => string;
  // Whether USER-typed content (comments, messages, captions, bios) is machine-
  // translated into `lang` automatically. Defaults OFF — the global default is
  // "tap to translate" (translations are only fetched when the viewer asks, and
  // only for content in a different real language). See lib/translate.ts +
  // useAutoTranslate. (Separate from `t`, which only does the static UI dict.)
  autoTranslate: boolean;
  setAutoTranslate: (on: boolean) => void;
};

const LanguageContext = createContext<LanguageContextValue>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => key,
  autoTranslate: false,
  setAutoTranslate: () => {},
});

export function useTranslation() {
  return useContext(LanguageContext);
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Default to English; a stored choice (loaded below) overrides it.
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);
  // Auto-translate user content: default OFF (tap-to-translate); a stored choice
  // overrides.
  const [autoTranslate, setAutoState] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (isLang(stored)) setLangState(stored);
    }).catch(() => {});
    AsyncStorage.getItem(AUTO_TRANSLATE_KEY).then((v) => {
      if (v != null) setAutoState(v === '1');
    }).catch(() => {});
  }, []);

  // Keep the module-level singleton (used by timeAgo, countLabel, and the data-
  // list label helpers — all outside the React tree) in sync with the active lang.
  useEffect(() => { setActiveLang(lang); }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    AsyncStorage.setItem(STORAGE_KEY, l).catch(() => {});
  }, []);

  const setAutoTranslate = useCallback((on: boolean) => {
    setAutoState(on);
    AsyncStorage.setItem(AUTO_TRANSLATE_KEY, on ? '1' : '0').catch(() => {});
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars), autoTranslate, setAutoTranslate }),
    [lang, setLang, autoTranslate, setAutoTranslate],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
