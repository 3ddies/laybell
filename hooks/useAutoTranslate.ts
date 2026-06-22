import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { translateText } from '../lib/translate';

// Per-text translation state for a piece of user-typed content. Drives
// <TranslatableText> and any bespoke renderer (message bubbles, captions).
//
// Auto mode (the global default): translates into the viewer's app language as
// soon as the text mounts, then shows the translation with a "Show original"
// toggle. If the text is already in the app language (or translation fails), it
// silently shows the original — no toggle, no flicker.
//
// Manual mode (auto off): shows the original with a "See translation" link that
// fetches on tap.

type Status = 'idle' | 'loading' | 'done';

export function useAutoTranslate(text?: string | null) {
  const { lang, autoTranslate } = useTranslation();
  const raw = (text ?? '').trim();

  const [translated, setTranslated] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [showOriginal, setShowOriginal] = useState(false);
  const reqId = useRef(0);

  async function run() {
    if (!raw) return;
    const id = ++reqId.current;
    setStatus('loading');
    const r = await translateText(raw, lang);
    if (id !== reqId.current) return; // a newer text/lang superseded this one
    setTranslated(r.text);
    setDetected(r.detected);
    setStatus('done');
  }

  // Reset + (re)translate whenever the text or target language changes.
  useEffect(() => {
    reqId.current++;
    setTranslated(null);
    setDetected(null);
    setStatus('idle');
    setShowOriginal(false);
    if (autoTranslate && raw) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, lang, autoTranslate]);

  // A real, useful translation: came back, differs from the original, and the
  // source wasn't already the target language.
  const hasTranslation =
    status === 'done' &&
    !!translated &&
    translated.trim().length > 0 &&
    translated.trim() !== raw &&
    (detected == null || detected !== lang);

  const shown = hasTranslation && !showOriginal ? (translated as string) : (text ?? '');

  function toggle() {
    if (status === 'done') setShowOriginal((v) => !v);
    else if (status === 'idle') { setShowOriginal(false); run(); } // manual "See translation"
  }

  return {
    shown,
    hasTranslation,
    showingOriginal: showOriginal,
    loading: status === 'loading',
    auto: autoTranslate,
    toggle,
  };
}
