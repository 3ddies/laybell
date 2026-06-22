# User-content translation — setup

This is the **runtime machine-translation of user-typed content** (comments,
messages, captions, bios) into each viewer's chosen app language. It is separate
from the app's own UI strings, which are localized statically in
[`lib/i18n.ts`](../lib/i18n.ts).

## How it works

- A viewer's language comes from **Settings → Language** (the existing picker).
- **Settings → Language → Auto-translate** (on by default) controls whether
  foreign-language content is translated automatically. Off = a "See
  translation" link instead.
- `components/TranslatableText.tsx` + `hooks/useAutoTranslate.ts` render the
  content, calling `lib/translate.ts`, which invokes the **`translate` Edge
  Function**. Results are cached in memory + AsyncStorage (each unique string is
  translated once per language), de-duplicated in-flight, and concurrency-capped.
- If translation fails or the text is already in the viewer's language, the
  **original** is shown — content never blanks.

Pure JS + network, so it ships over-the-air (no native rebuild).

## 1. Deploy the Edge Function

```
supabase functions deploy translate
```

It works **with no API key** out of the box using a public LibreTranslate
instance, so you can try it immediately. Public instances are best-effort —
for anything beyond testing, set a provider below.

## 2. Choose a provider (one secret change)

```
# (a) LibreTranslate — free / self-hostable (DEFAULT). Point at a reachable
#     instance, or self-host:  docker run -ti -p 5000:5000 libretranslate/libretranslate
supabase secrets set TRANSLATE_PROVIDER=libre
supabase secrets set LIBRETRANSLATE_URL=https://your-instance.example
supabase secrets set LIBRETRANSLATE_API_KEY=...        # only if your instance requires one

# (b) Google Cloud Translation — covers all 10 app languages incl. Hindi
supabase secrets set TRANSLATE_PROVIDER=google
supabase secrets set GOOGLE_TRANSLATE_API_KEY=...

# (c) DeepL — high quality, free tier; NO Hindi (hi content shows untranslated)
supabase secrets set TRANSLATE_PROVIDER=deepl
supabase secrets set DEEPL_API_KEY=...
```

No redeploy needed after changing secrets.

## Request / response

```
POST translate   { "q": "hola" | ["hola","mundo"], "target": "en" }
→ { "translations": [{ "text": "hello", "detected": "es" }] }
```

The function is JWT-verified (Supabase default); the client passes the signed-in
user's token automatically via `supabase.functions.invoke`.

## Notes & cost

- **Volume:** with auto-translate on, the home feed translates captions as you
  scroll. The cache + same-language skip keep this sane, but a high-traffic
  feed on a free public LibreTranslate instance may rate-limit. For production,
  self-host LibreTranslate or use Google/DeepL.
- **Future optimization:** a server-side translations cache table (shared across
  users) would cut provider calls dramatically vs. the current per-device cache.
- **Surfaces wired:** comments, direct messages (incl. story replies), post
  captions (feed / post view / reels), and profile bios. Display names, playlist
  names, and ad creative are intentionally left untranslated.
