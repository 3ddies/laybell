import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../contexts/LanguageContext';
import { translateText } from '../lib/translate';
import { detectLang } from '../lib/detectLang';

// Per-text translation state for a piece of user-typed content. Drives
// <TranslatableText> and any bespoke renderer (message bubbles, captions).
//
// "Tap to translate" is the global default: text shows in its original language
// with a translate link, and we only fetch a translation when the viewer taps —
// so we never burn translations on content they didn't want to read. The link
// appears ONLY when a cheap, network-free local guess says the text is a real
// language DIFFERENT from the viewer's (so same-language text and gibberish get
// no link and never hit the API).
//
// Auto mode (opt-in via Settings → Auto-translate): the same gate applies, but a
// qualifying text is translated on mount and shown with a "Show original" toggle.

type Status = 'idle' | 'loading' | 'done';

export function useAutoTranslate(text?: string | null) {
  const { lang, autoTranslate } = useTranslation();
  const raw = (text ?? '').trim();

  // Network-free language guess. We only offer translation when the text looks
  // like a different, real language than the viewer's.
  const detectedLocal = useMemo(() => detectLang(raw), [raw]);
  const translatable = !!detectedLocal && detectedLocal !== lang;

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

  // Reset whenever the text or target language changes. Auto mode (opt-in)
  // translates eagerly, but only for text the local gate flags as foreign.
  useEffect(() => {
    reqId.current++;
    setTranslated(null);
    setDetected(null);
    setStatus('idle');
    setShowOriginal(false);
    if (autoTranslate && translatable && raw) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, lang, autoTranslate, translatable]);

  // A real, useful translation: came back, differs from the original, and the
  // source wasn't already the target language.
  const hasTranslation =
    status === 'done' &&
    !!translated &&
    translated.trim().length > 0 &&
    translated.trim() !== raw &&
    (detected == null || detected !== lang);

  const shown = hasTranslation && !showOriginal ? (translated as string) : (text ?? '');

  // Offer the "tap to translate" link only when it's worth it and not done yet.
  const canTranslate = translatable && status !== 'loading' && !hasTranslation;

  function toggle() {
    if (status === 'done') setShowOriginal((v) => !v);
    else if (status === 'idle' && translatable) { setShowOriginal(false); run(); } // tap to translate
  }

  return {
    shown,
    hasTranslation,
    canTranslate,
    showingOriginal: showOriginal,
    loading: status === 'loading',
    toggle,
  };
}
