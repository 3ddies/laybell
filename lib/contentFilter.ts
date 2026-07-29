import { supabase } from './supabase';

// Text content filter — the "method for filtering objectionable material from
// being posted" that Apple Guideline 1.2 and Play's UGC policy expect a
// user-generated-content app to have. Laybell had reporting, blocking and a
// moderation console, but nothing that stopped objectionable text at post time.
//
// Deliberately modelled on lib/linkSafety.ts: a small built-in seed so the filter
// works in a fresh install, merged over a curated table the owner can tune from
// the dashboard WITHOUT shipping an app update — moderation policy changes far
// faster than release cycles. Degrades gracefully: no table, no network, no
// problem; the seed still applies.
//
// Two severities, because "refuse everything suspicious" produces a filter people
// route around:
//   'block'  → refuse the write outright, tell the user.
//   'review' → let it through, but flag it for the moderation queue.
//
// This is a SPEED BUMP, not a security boundary. It runs client-side, so a
// modified client bypasses it. Real enforcement is the moderation console plus
// reporting; this exists to stop casual abuse and to satisfy the store rule.

export type FilterSeverity = 'block' | 'review';
export type FilterHit = { term: string; severity: FilterSeverity };
export type FilterResult = { ok: boolean; severity: FilterSeverity | null; hits: FilterHit[] };

type Rule = { pattern: RegExp; label: string; severity: FilterSeverity };

// ── Normalization ────────────────────────────────────────────────────────────
// Naive substring matching is trivially evaded ("h.a.t.e", "ｈａｔｅ", "h4te",
// "haaate"), so normalize aggressively before matching. This is where nearly all
// the value of a term filter actually lives.
const LEET_DIGIT: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
};
const LEET_SYMBOL: Record<string, string> = { '@': 'a', '$': 's', '!': 'i' };

export function normalizeForFilter(input: string): string {
  return (input || '')
    .normalize('NFKD')                        // fold full-width + decompose accents
    .replace(/[̀-ͯ]/g, '')          // strip combining marks
    .replace(/[​-‍﻿]/g, '')    // strip zero-width evasion characters
    .toLowerCase()
    // Digits are never punctuation, so substitute them anywhere ("4ss", "n1gga").
    .replace(/[013457]/g, (c) => LEET_DIGIT[c] ?? c)
    // Symbols double as real punctuation, so substitute them ONLY between two
    // alphanumerics. Otherwise an ordinary "nudes!!!" normalizes to "nudesii" and
    // stops matching \bnudes\b — i.e. trailing punctuation silently defeats the
    // whole filter. Interior use ("n!gger") is still caught.
    .replace(/(?<=[a-z0-9])[@$!](?=[a-z0-9])/g, (c) => LEET_SYMBOL[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1')            // "haaaate" → "haate"
    .replace(/[^a-z0-9\s]/g, ' ')             // punctuation becomes a separator
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Built-in seed ────────────────────────────────────────────────────────────
// Intentionally SMALL and limited to categories that are unambiguous: dehumanizing
// slurs, and sexual solicitation — the latter matters most because Laybell has
// 13-17 year olds and DMs. Everything nuanced (harassment, self-harm, spam) is
// left to the server list and human moderation, because a blunt keyword filter
// gets those wrong far more often than right.
//
// Word boundaries are mandatory: matching bare substrings creates the classic
// false positive where an innocent word contains a flagged one.
const b = (word: string) => new RegExp(`\\b${word}\\b`);

const SEED: Rule[] = [
  // Sexual solicitation / grooming patterns. Phrases, not single words, because
  // the individual words are innocuous and the combination is what signals intent.
  { pattern: /\bsend (me )?(your )?(nudes?|pics?? of you)\b/, label: 'solicitation', severity: 'block' },
  { pattern: /\b(nudes?|naked pics?)\s+(for|4)\s+(cash|money|\$)/, label: 'solicitation', severity: 'block' },
  { pattern: /\bhow old are you\b.{0,40}\b(sexy|hot|nudes?|alone)\b/, label: 'grooming', severity: 'review' },
  { pattern: /\b(dont|do not) tell your (mom|dad|parents?)\b/, label: 'grooming', severity: 'review' },
  { pattern: /\b(snap|kik|telegram) me\b.{0,30}\b(nudes?|pics?|sexy)\b/, label: 'solicitation', severity: 'block' },
  // Explicit-content-for-sale spam, the most common UGC spam shape.
  { pattern: /\bonly ?fans\b.{0,20}\blink in bio\b/, label: 'adult-spam', severity: 'review' },
  // Dehumanizing slurs. Kept minimal here on purpose — this list is a starting
  // point the owner MUST expand from the dashboard (see content_filter.sql), not
  // a complete policy.
  { pattern: b('n[i1]gg(er|a)'), label: 'slur', severity: 'block' },
  { pattern: b('f[a4]gg?(ot)?'), label: 'slur', severity: 'block' },
  { pattern: b('tr[a4]nny'), label: 'slur', severity: 'block' },
  { pattern: b('k[i1]ke'), label: 'slur', severity: 'block' },
  { pattern: b('ch[i1]nk'), label: 'slur', severity: 'block' },
  { pattern: b('sp[i1]c'), label: 'slur', severity: 'block' },
  { pattern: b('r[e3]t[a4]rd'), label: 'slur', severity: 'review' },
];

// ── Curated server list ──────────────────────────────────────────────────────
// Fetched once per session and merged over the seed. Stored as plain terms rather
// than regexes so a non-engineer can maintain it; each is matched on word
// boundaries against the normalized text.
let serverRules: Rule[] | null = null;
let loading: Promise<void> | null = null;

export async function loadTermBlocklist(): Promise<void> {
  if (serverRules || loading) return loading ?? undefined;
  loading = (async () => {
    try {
      const { data } = await supabase
        .from('blocked_terms').select('term, severity').limit(2000);
      serverRules = (data ?? []).map((r: any) => ({
        // Escape: these are literal terms typed by a human, not patterns.
        pattern: new RegExp(`\\b${String(r.term ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        label: String(r.term ?? ''),
        severity: (r.severity === 'review' ? 'review' : 'block') as FilterSeverity,
      })).filter((r) => r.label);
    } catch {
      serverRules = []; // pre-migration or offline — the seed still applies
    }
  })();
  await loading;
  loading = null;
}

// ── The check ────────────────────────────────────────────────────────────────

/** Synchronous check against the seed + whatever server list has been loaded. */
export function checkText(input: string): FilterResult {
  const text = normalizeForFilter(input);
  if (!text) return { ok: true, severity: null, hits: [] };

  const hits: FilterHit[] = [];
  for (const rule of [...SEED, ...(serverRules ?? [])]) {
    if (rule.pattern.test(text)) hits.push({ term: rule.label, severity: rule.severity });
  }
  if (!hits.length) return { ok: true, severity: null, hits: [] };
  const blocked = hits.some((h) => h.severity === 'block');
  return { ok: !blocked, severity: blocked ? 'block' : 'review', hits };
}

/** Loads the curated list if needed, then checks. Use on write paths. */
export async function checkTextAsync(input: string): Promise<FilterResult> {
  await loadTermBlocklist();
  return checkText(input);
}

/**
 * Check several fields at once (caption + title, say). Returns the worst result.
 */
export async function checkFields(...fields: (string | null | undefined)[]): Promise<FilterResult> {
  await loadTermBlocklist();
  const all: FilterHit[] = [];
  for (const f of fields) {
    if (!f) continue;
    all.push(...checkText(f).hits);
  }
  if (!all.length) return { ok: true, severity: null, hits: [] };
  const blocked = all.some((h) => h.severity === 'block');
  return { ok: !blocked, severity: blocked ? 'block' : 'review', hits: all };
}
