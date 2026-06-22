import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// Client for the `translate` Edge Function — machine-translates USER-typed text
// (comments, messages, captions, bios) into the viewer's chosen app language.
// (The app's own UI strings are localized statically in lib/i18n.ts; this is a
// separate, network-based concern.) Pure JS + network, so it stays OTA-safe.
//
// Three things keep cost/volume sane on a free translation backend:
//   1. in-memory + AsyncStorage cache, keyed by target+text (same text is only
//      ever translated once per language, across renders and app launches),
//   2. in-flight de-duplication (a list of identical comments → one request),
//   3. a small concurrency cap so opening a long thread doesn't fan out 50
//      requests at once and trip a rate limit.
// Any failure resolves to the ORIGINAL text (never blanks content).

export type TranslationResult = { text: string; detected: string | null };

const mem = new Map<string, TranslationResult>();
const inflight = new Map<string, Promise<TranslationResult>>();
const STORAGE_PREFIX = 'tr:';

const MAX_CONCURRENT = 4;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(() => { active++; resolve(); }));
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

const keyFor = (text: string, target: string) => `${target}\n${text}`;

/**
 * Translate a single string into `target` (an app language code). Resolves to
 * `{ text, detected }`; on any error resolves to the original text with
 * `detected: null` so callers can render unconditionally.
 */
export async function translateText(text: string | null | undefined, target: string): Promise<TranslationResult> {
  const raw = (text ?? '').trim();
  if (!raw) return { text: text ?? '', detected: null };

  const k = keyFor(raw, target);
  const cached = mem.get(k);
  if (cached) return cached;
  const pending = inflight.get(k);
  if (pending) return pending;

  // This promise NEVER rejects — concurrent callers may receive it directly
  // (via the in-flight map), so a failure must resolve to the original text for
  // all of them. Failures are not cached, so a later view retries.
  const p = (async (): Promise<TranslationResult> => {
    // Persistent cache first (survives app restarts).
    try {
      const stored = await AsyncStorage.getItem(STORAGE_PREFIX + k);
      if (stored) { const r = JSON.parse(stored) as TranslationResult; mem.set(k, r); return r; }
    } catch {}

    await acquire();
    try {
      const { data, error } = await supabase.functions.invoke('translate', { body: { q: raw, target } });
      const first = (data as any)?.translations?.[0];
      if (error || !first) throw error ?? new Error('translate: empty response');
      const result: TranslationResult = { text: first.text ?? raw, detected: first.detected ?? null };
      mem.set(k, result);
      AsyncStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(result)).catch(() => {});
      return result;
    } catch {
      return { text: text ?? '', detected: null }; // graceful: show original (not cached)
    } finally {
      release();
    }
  })();

  inflight.set(k, p);
  try {
    return await p;
  } finally {
    inflight.delete(k);
  }
}
