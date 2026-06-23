// Link safety — detects, normalizes, and risk-classifies every user-supplied URL
// before it can be opened (profile links/bios, direct messages, ad creatives).
//
// Pure + OFFLINE by default: scheme / host / heuristic checks against a curated
// blocklist, so it works with no network and no API key. An OPTIONAL async
// reputation check (the Supabase `check-link` Edge Function, backed by Google
// Safe Browsing / URLhaus) layers on top when configured and degrades gracefully
// when it isn't — exactly like the translate function.
//
// Verdicts:
//   'block' — never open (dangerous scheme, embedded credentials, blocklisted
//             host, unknown scheme…). Hard-stopped by the UI.
//   'warn'  — open only AFTER an explicit interstitial that flags the risk
//             (URL shorteners that hide the destination, raw-IP or punycode
//             hosts, suspicious TLDs, plaintext http…).
//   'allow' — an ordinary external link. Still shown through the "leaving
//             Laybell" interstitial so the user always sees the real destination.
//
// Design rule: FAIL SAFE. Anything we can't confidently parse or classify is at
// least 'warn', never silently 'allow'.

import { supabase } from './supabase';

export type LinkVerdict = 'allow' | 'warn' | 'block';

export type LinkReasonCode =
  | 'dangerous_scheme'
  | 'unknown_scheme'
  | 'embedded_credentials'
  | 'blocklisted'
  | 'ip_host'
  | 'punycode'
  | 'shortener'
  | 'suspicious_tld'
  | 'non_https'
  | 'no_host'
  | 'too_long'
  | 'many_subdomains'
  | 'adult_keyword'      // explicit/adult term in the URL → block
  | 'sensitive_keyword' // triggering-but-ambiguous term in the URL → warn
  | 'unparseable';

export type LinkAnalysis = {
  raw: string;
  // Canonical URL to open (https forced when the user typed a bare domain), or
  // null when there's nothing safe/parseable to open.
  normalized: string | null;
  scheme: string | null;
  host: string | null; // lowercased hostname, null for mailto/tel/unparseable
  verdict: LinkVerdict;
  reasons: LinkReasonCode[];
};

// Schemes we will ever open. Everything else is blocked outright — this is what
// stops javascript:, data:, file:, intent:, and lookalike custom app schemes.
const SAFE_WEB_SCHEMES = new Set(['http', 'https']);
const SAFE_OTHER_SCHEMES = new Set(['mailto', 'tel', 'sms']);
const DANGEROUS_SCHEMES = new Set([
  'javascript', 'data', 'file', 'blob', 'intent', 'vbscript', 'about', 'content',
]);

// URL shorteners hide their final destination, so they can't be vouched for —
// always 'warn'. (Server reputation, when enabled, can still resolve + block.)
const SHORTENER_HOSTS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 't.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'bl.ink',
  'lnkd.in', 'trib.al', 'shor.by', 'linktr.ee', 'snip.ly', 'soo.gd', 's.id',
]);

// TLDs disproportionately abused for phishing/malware or that double as risky
// file extensions (.zip/.mov). Not proof of malice — just 'warn'.
const SUSPICIOUS_TLDS = new Set([
  'zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq', 'country', 'kim', 'work', 'click',
  'link', 'loan', 'download', 'review', 'top', 'xin', 'gdn', 'racing', 'stream',
  'win', 'bid', 'date', 'faith', 'cricket', 'science', 'party', 'rest', 'quest',
]);

// ── Unsafe-keyword screening ─────────────────────────────────────────────────
// Two tiers, two matching strategies to avoid the "Scunthorpe problem" (don't
// block sussex.gov.uk / analysis.com / therapeutic.org for containing a
// substring). The URL host+path is split into LETTER-ONLY tokens (so "sex123"
// and "best-sex-toys" tokenize to ["sex",…] but "sussex"/"unisex" stay whole):
//   • *_EXACT  — matched only as a WHOLE token (short/ambiguous words).
//   • *_SUBSTR — matched anywhere in the URL (long, distinctive words that
//                effectively never occur inside an innocent word).
//
// BLOCK tier → explicit/adult terms: the link is rejected.
const ADULT_BLOCK_EXACT = new Set<string>([
  // NOTE: bare 'sex' is intentionally in the WARN tier (below), not here, so
  // sexual-health / sex-education / LGBTQ resources are flagged, not rejected.
  'xxx', 'nude', 'nudes', 'nsfw', 'milf', 'rape', 'escort', 'escorts',
  'fetish', 'bdsm', 'anal', 'blowjob', 'creampie', 'cum', 'cumshot', 'cock',
  'pussy', 'tits', 'boobs', 'slut', 'whore', 'orgy', 'gangbang', 'sextape',
  'camsex', 'sexcam', 'deepthroat', 'bukkake', 'handjob', 'fuck', 'fucking',
]);
const ADULT_BLOCK_SUBSTR = [
  'porn', 'xvideos', 'xnxx', 'xhamster', 'pornhub', 'youporn', 'redtube',
  'onlyfans', 'brazzers', 'hentai', 'camgirl', 'bestiality', 'incest',
];

// WARN tier → triggering but ambiguous / sensitive-category terms: flagged in
// the interstitial, NOT blocked.
const SENSITIVE_WARN_EXACT = new Set<string>([
  'sex', 'sexy', 'dating', 'hookup', 'hookups', 'cam', 'cams', 'bet', 'poker', 'weed',
  'cbd', 'vape', 'singles', 'crypto', 'forex', 'pharmacy', 'pills', 'kink',
]);
const SENSITIVE_WARN_SUBSTR = [
  'adult', 'webcam', 'viagra', 'cialis', 'gambling', 'casino', 'betting',
  'lottery', 'payday', 'cannabis',
];

// Split a URL's host+path into letter-only tokens for exact matching.
function letterTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function hasKeyword(scanTarget: string, exact: Set<string>, substr: string[]): boolean {
  const lower = scanTarget.toLowerCase();
  if (substr.some((kw) => lower.includes(kw))) return true;
  const toks = letterTokens(scanTarget);
  return toks.some((tok) => exact.has(tok));
}

// Curated seed blocklist. The authoritative list lives in the DB table
// `blocked_link_domains` (see supabase/sql/link_safety.sql); the app fetches it
// once and merges it in via setRuntimeBlocklist(). Matching is host-or-suffix:
// "evil.com" also blocks "login.evil.com".
const SEED_BLOCKLIST = new Set<string>([
  // Illustrative placeholders — replace/extend from the DB feed.
  'example-phishing.com',
  'malware.test',
]);

let runtimeBlocklist = new Set<string>(SEED_BLOCKLIST);

// Merge a server-fetched blocklist (lowercased hosts) over the seed. Call once at
// startup after fetching `blocked_link_domains`.
export function setRuntimeBlocklist(hosts: string[]): void {
  runtimeBlocklist = new Set<string>([...SEED_BLOCKLIST, ...hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
}

// Fetch + install the DB blocklist (best-effort; no-ops if the table is absent).
export async function loadBlocklist(): Promise<void> {
  try {
    const { data, error } = await supabase.from('blocked_link_domains').select('domain').limit(5000);
    if (error || !data) return;
    setRuntimeBlocklist((data as any[]).map((r) => r.domain));
  } catch {
    /* table not migrated yet — keep the seed */
  }
}

function hostIsBlocklisted(host: string): boolean {
  const h = host.toLowerCase();
  if (runtimeBlocklist.has(h)) return true;
  // Suffix match so subdomains of a blocked host are caught too.
  for (const bad of runtimeBlocklist) {
    if (h === bad || h.endsWith('.' + bad)) return true;
  }
  return false;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i;

type Parsed = { scheme: string | null; hadCreds: boolean; host: string | null; rest: string };

// Deterministic, dependency-free parse (the WHATWG URL polyfill isn't guaranteed
// in RN and varies on IDN/credential handling — which is exactly what we're
// checking). Returns the lowercased host, whether credentials were embedded, and
// the path/query remainder.
function parseUrl(raw: string): Parsed {
  const trimmed = (raw ?? '').trim();
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  let rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed;

  // mailto:/tel:/sms: have no authority component.
  if (scheme && SAFE_OTHER_SCHEMES.has(scheme)) {
    return { scheme, hadCreds: false, host: null, rest };
  }

  const afterSlashes = rest.replace(/^\/\//, '');
  // Authority ends at the first /, ?, or #.
  const authority = afterSlashes.split(/[/?#]/)[0] ?? '';
  const hadCreds = authority.includes('@');
  const hostPort = authority.split('@').pop() ?? '';
  // Strip a :port (but keep IPv6 brackets intact).
  let host = hostPort;
  if (!host.startsWith('[')) host = host.split(':')[0];
  host = host.toLowerCase().replace(/\.+$/, ''); // drop trailing dots
  return { scheme, hadCreds, host: host || null, rest: afterSlashes };
}

function tldOf(host: string): string {
  const parts = host.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

// Combine two verdicts, taking the more severe.
const SEVERITY: Record<LinkVerdict, number> = { allow: 0, warn: 1, block: 2 };
export function worstVerdict(a: LinkVerdict, b: LinkVerdict): LinkVerdict {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ── The core synchronous classifier ──────────────────────────────────────────
export function analyzeUrl(raw: string): LinkAnalysis {
  const reasons: LinkReasonCode[] = [];
  const base: LinkAnalysis = { raw, normalized: null, scheme: null, host: null, verdict: 'allow', reasons };

  if (!raw || !raw.trim()) {
    return { ...base, verdict: 'block', reasons: ['unparseable'] };
  }

  const { scheme, hadCreds, host, rest } = parseUrl(raw);
  base.scheme = scheme;
  base.host = host;

  // 1) Dangerous / unknown schemes — hard block.
  if (scheme && DANGEROUS_SCHEMES.has(scheme)) {
    return { ...base, verdict: 'block', reasons: ['dangerous_scheme'] };
  }
  if (scheme && !SAFE_WEB_SCHEMES.has(scheme) && !SAFE_OTHER_SCHEMES.has(scheme)) {
    // Unknown custom scheme (e.g. a deep link to another app) — don't open it.
    return { ...base, verdict: 'block', reasons: ['unknown_scheme'] };
  }

  // 2) mailto:/tel:/sms: — allowed, no host checks.
  if (scheme && SAFE_OTHER_SCHEMES.has(scheme)) {
    return { ...base, normalized: raw.trim(), verdict: 'allow', reasons: [] };
  }

  // 3) Embedded credentials (http://paypal.com@evil.com) — classic phishing.
  if (hadCreds) reasons.push('embedded_credentials');

  // 4) Must have a plausible host.
  if (!host) {
    return { ...base, verdict: 'block', reasons: [...reasons, 'no_host'] };
  }
  const looksLikeHost = host.includes('.') || IPV4_RE.test(host) || IPV6_RE.test(host) || host === 'localhost';
  if (!looksLikeHost) {
    return { ...base, verdict: 'block', reasons: [...reasons, 'unparseable'] };
  }

  // 5) Host-based signals.
  if (hostIsBlocklisted(host)) reasons.push('blocklisted');
  if (IPV4_RE.test(host) || IPV6_RE.test(host) || host === 'localhost') reasons.push('ip_host');
  if (host.includes('xn--')) reasons.push('punycode'); // IDN homograph risk
  if (SHORTENER_HOSTS.has(host)) reasons.push('shortener');
  if (SUSPICIOUS_TLDS.has(tldOf(host))) reasons.push('suspicious_tld');
  if (host.split('.').length > 5) reasons.push('many_subdomains');

  // 6) Transport + shape signals.
  if (scheme === 'http') reasons.push('non_https');
  if (raw.length > 300) reasons.push('too_long');

  // 6b) Unsafe-keyword screening over host + path (NOT the scheme). Explicit
  // terms reject the link; ambiguous/sensitive terms only flag it.
  if (hasKeyword(rest, ADULT_BLOCK_EXACT, ADULT_BLOCK_SUBSTR)) reasons.push('adult_keyword');
  else if (hasKeyword(rest, SENSITIVE_WARN_EXACT, SENSITIVE_WARN_SUBSTR)) reasons.push('sensitive_keyword');

  // 7) Build the canonical URL to open (force https when the user typed a bare
  // domain; keep an explicit http scheme so the 'non_https' warning is honest).
  const outScheme = scheme === 'http' ? 'http' : 'https';
  const normalized = `${outScheme}://${rest.replace(/^\/\//, '')}`;

  // 8) Resolve the verdict from the collected reasons.
  const BLOCK_REASONS: LinkReasonCode[] = ['embedded_credentials', 'blocklisted', 'adult_keyword'];
  let verdict: LinkVerdict = 'allow';
  if (reasons.some((r) => BLOCK_REASONS.includes(r))) verdict = 'block';
  else if (reasons.length > 0) verdict = 'warn';

  return { raw, normalized: verdict === 'block' ? null : normalized, scheme, host, verdict, reasons };
}

// ── Optional server reputation check ─────────────────────────────────────────
// Calls the `check-link` Edge Function (Safe Browsing / URLhaus). Returns a
// verdict to merge with the sync one, or null when unavailable. Never throws.
export async function checkUrlReputation(url: string): Promise<LinkVerdict | null> {
  try {
    const { data, error } = await supabase.functions.invoke('check-link', { body: { url } });
    if (error || !data) return null;
    const v = (data as any).verdict;
    return v === 'block' || v === 'warn' || v === 'allow' ? v : null;
  } catch {
    return null;
  }
}

// ── Free-text URL extraction (messages, bios, ad body) ───────────────────────
// Conservative: explicit http(s) URLs, www.* , and bare host/path with a TLD.
// Used to scan text for risky links and to block sending/saving the worst ones.
// Explicit http(s)/www URLs, OR a bare host (label(.label)*.tld) with an optional
// path. The bare-host branch needs only domain.tld (two labels) — NOT a forced
// subdomain — so "github.com" and "evil.com" are both caught.
const URL_IN_TEXT_RE =
  /\b((?:https?:\/\/|www\.)[^\s<>()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>()]*)?)/gi;

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const u = m[1].replace(/[.,!?)]+$/, ''); // trim trailing sentence punctuation
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// Scan a block of text and return the most severe verdict + the offending URL.
// Used at the source (send a message / save a bio / submit an ad) to refuse the
// worst content before it ever persists.
export function scanText(text: string): { verdict: LinkVerdict; worst: LinkAnalysis | null } {
  let verdict: LinkVerdict = 'allow';
  let worst: LinkAnalysis | null = null;
  for (const u of extractUrls(text)) {
    const a = analyzeUrl(u);
    if (!worst || SEVERITY[a.verdict] > SEVERITY[worst.verdict]) worst = a;
    verdict = worstVerdict(verdict, a.verdict);
  }
  return { verdict, worst };
}

// Best-effort report of a suspicious link (graceful if the table is absent).
export async function reportLink(rawUrl: string, context: 'bio' | 'message' | 'ad' | 'other'): Promise<boolean> {
  try {
    const a = analyzeUrl(rawUrl);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('link_reports').insert({
      reporter_id: user?.id ?? null,
      url: rawUrl.slice(0, 2048),
      host: a.host,
      context,
      verdict: a.verdict,
      reasons: a.reasons,
    });
    return !error;
  } catch {
    return false;
  }
}

// Best-effort audit log of a block/open decision (evidence of reasonable
// handling). Graceful if the table is absent.
export async function auditLinkDecision(a: LinkAnalysis, action: 'opened' | 'blocked' | 'cancelled', context: string): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('link_audit').insert({
      user_id: user?.id ?? null,
      url: a.raw.slice(0, 2048),
      host: a.host,
      verdict: a.verdict,
      reasons: a.reasons,
      action,
      context,
    });
  } catch {
    /* table not migrated yet */
  }
}
