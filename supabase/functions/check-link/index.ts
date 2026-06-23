import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Server-side URL reputation check for the link-safety guard (lib/linkSafety.ts
// → checkUrlReputation). The CLIENT already runs offline heuristics + the curated
// blocklist; this layers a live threat feed on top so freshly-reported phishing/
// malware is caught even when the static rules miss it.
//
// Pluggable provider so the key/billing choice is a one-secret change and the
// client never sees an API key. Configure via Supabase function secrets:
//
//   # Google Safe Browsing v4 (recommended):
//   supabase secrets set LINK_CHECK_PROVIDER=safebrowsing GOOGLE_SAFE_BROWSING_KEY=...
//   # URLhaus (abuse.ch — free, no key; host/url lookups):
//   supabase secrets set LINK_CHECK_PROVIDER=urlhaus
//
// Request:  { url: string }
// Response: { verdict: "allow" | "warn" | "block", source: string }
// On ANY error or when no provider is configured it returns { verdict: "allow",
// source: "none" } so the guard degrades gracefully to the client-side rules —
// it NEVER blocks the app on a flaky/absent reputation service.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Verdict = 'allow' | 'warn' | 'block';

const PROVIDER = (Deno.env.get('LINK_CHECK_PROVIDER') ?? 'none').toLowerCase();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ─── Google Safe Browsing v4 ──────────────────────────────────────────────────
async function viaSafeBrowsing(url: string): Promise<Verdict> {
  const key = Deno.env.get('GOOGLE_SAFE_BROWSING_KEY') ?? '';
  if (!key) return 'allow';
  const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client: { clientId: 'laybell', clientVersion: '1.0.0' },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url }],
      },
    }),
  });
  if (!res.ok) return 'allow';
  const data = await res.json();
  return Array.isArray(data.matches) && data.matches.length > 0 ? 'block' : 'allow';
}

// ─── URLhaus (abuse.ch) ───────────────────────────────────────────────────────
async function viaUrlhaus(url: string): Promise<Verdict> {
  const res = await fetch('https://urlhaus-api.abuse.ch/v1/url/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url }),
  });
  if (!res.ok) return 'allow';
  const data = await res.json();
  if (data.query_status === 'ok' && data.url_status === 'online' && data.threat) return 'block';
  if (data.query_status === 'ok') return 'warn'; // listed but offline/unknown — caution
  return 'allow';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') return json({ verdict: 'allow', source: 'none' });

    let verdict: Verdict = 'allow';
    if (PROVIDER === 'safebrowsing') verdict = await viaSafeBrowsing(url);
    else if (PROVIDER === 'urlhaus') verdict = await viaUrlhaus(url);

    return json({ verdict, source: PROVIDER });
  } catch {
    // Fail OPEN to the client-side rules — never hard-block on a check failure.
    return json({ verdict: 'allow', source: 'error' });
  }
});
