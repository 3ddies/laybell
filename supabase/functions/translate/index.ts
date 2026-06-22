import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Machine-translation proxy for USER-GENERATED content (comments, messages,
// captions, bios). The app's own UI strings are handled by the static
// dictionary in lib/i18n.ts — this is only for free-text the users type.
//
// Pluggable provider so the key/billing choice stays a one-secret change and
// the client never sees an API key. Configure via Supabase function secrets:
//
//   supabase secrets set TRANSLATE_PROVIDER=libre        # libre | google | deepl
//   # LibreTranslate (free / no key by default — point at a reachable instance,
//   # or self-host:  docker run -ti -p 5000:5000 libretranslate/libretranslate)
//   supabase secrets set LIBRETRANSLATE_URL=https://translate.argosopentech.com
//   supabase secrets set LIBRETRANSLATE_API_KEY=...       # only if your instance needs one
//   # Google Cloud Translation v2 (covers all 10 app languages incl. Hindi):
//   supabase secrets set TRANSLATE_PROVIDER=google GOOGLE_TRANSLATE_API_KEY=...
//   # DeepL (no Hindi):
//   supabase secrets set TRANSLATE_PROVIDER=deepl DEEPL_API_KEY=...
//
// Request:  { q: string | string[], target: "es" }
// Response: { translations: [{ text: string, detected: string | null }] }
// On any provider failure it throws (500); the client falls back to the
// original text, so a flaky free instance degrades gracefully instead of
// blanking content.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Out = { text: string; detected: string | null };

const PROVIDER = (Deno.env.get('TRANSLATE_PROVIDER') ?? 'libre').toLowerCase();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ─── LibreTranslate (default — free, self-hostable, auto-detects source) ───────
async function viaLibre(texts: string[], target: string): Promise<Out[]> {
  const base = (Deno.env.get('LIBRETRANSLATE_URL') ?? 'https://translate.argosopentech.com').replace(/\/$/, '');
  const apiKey = Deno.env.get('LIBRETRANSLATE_API_KEY') ?? '';
  const res = await fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, source: 'auto', target, format: 'text', ...(apiKey ? { api_key: apiKey } : {}) }),
  });
  if (!res.ok) throw new Error(`libre ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Array input → array out; some instances return a scalar for a single item.
  const translated: string[] = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
  const detected = data.detectedLanguage;
  return texts.map((_, i) => ({
    text: translated[i] ?? texts[i],
    detected: Array.isArray(detected) ? (detected[i]?.language ?? null) : (detected?.language ?? null),
  }));
}

// ─── Google Cloud Translation v2 ──────────────────────────────────────────────
async function viaGoogle(texts: string[], target: string): Promise<Out[]> {
  const key = Deno.env.get('GOOGLE_TRANSLATE_API_KEY');
  if (!key) throw new Error('GOOGLE_TRANSLATE_API_KEY not set');
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target, format: 'text' }),
  });
  if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const arr = data?.data?.translations ?? [];
  return texts.map((orig, i) => ({
    text: decodeEntities(arr[i]?.translatedText ?? orig),
    detected: arr[i]?.detectedSourceLanguage ?? null,
  }));
}

// ─── DeepL (no Hindi support; those texts come back unchanged) ─────────────────
const DEEPL_TARGET: Record<string, string> = { en: 'EN-US', pt: 'PT-BR' };
async function viaDeepl(texts: string[], target: string): Promise<Out[]> {
  const key = Deno.env.get('DEEPL_API_KEY');
  if (!key) throw new Error('DEEPL_API_KEY not set');
  if (target === 'hi') return texts.map((t) => ({ text: t, detected: null })); // DeepL has no Hindi
  const url = Deno.env.get('DEEPL_API_URL') ?? 'https://api-free.deepl.com/v2/translate';
  const body = new URLSearchParams();
  texts.forEach((t) => body.append('text', t));
  body.append('target_lang', DEEPL_TARGET[target] ?? target.toUpperCase());
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`deepl ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const arr = data?.translations ?? [];
  return texts.map((orig, i) => ({
    text: arr[i]?.text ?? orig,
    detected: (arr[i]?.detected_source_language ?? '').toLowerCase() || null,
  }));
}

// Google returns HTML entities even with format:text in some cases.
function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function translateBatch(texts: string[], target: string): Promise<Out[]> {
  if (PROVIDER === 'google') return viaGoogle(texts, target);
  if (PROVIDER === 'deepl') return viaDeepl(texts, target);
  return viaLibre(texts, target);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { q, target } = await req.json();
    const texts: string[] = Array.isArray(q) ? q : [q];
    if (!target || texts.length === 0 || texts.some((t) => typeof t !== 'string')) {
      return json({ error: 'q (string|string[]) and target required' }, 400);
    }
    const translations = await translateBatch(texts, target);
    return json({ translations });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
