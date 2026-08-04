import { extractUrls } from './linkSafety';

// Self-promotion detection for Community Guidelines §9 (comments are not ad
// space) and §10 (posts that function as ads outside Ad Manager).
//
// DESIGN: signals, not a verdict. Nothing here removes, blocks, or demotes
// anything on its own. A comment match raises a warning the user can dismiss;
// a post match only puts the post in front of a human. That split is the whole
// reason this can be a heuristic at all — a wrong guess costs a dismissible
// sheet or a moderator's glance, never someone's reach.
//
// KNOWN LIMIT — ENGLISH ONLY. The phrase lists below are English, and Laybell
// ships in ten languages. A Spanish or Japanese promo comment will not match.
// That is a deliberate false-NEGATIVE bias: under-detecting leaves a rule
// unenforced, while machine-translating these lists would produce confident
// nonsense that silences people in languages nobody here can spot-check. Add
// languages when a native speaker can write the list.

export type PromoSignal =
  | 'external_link'
  | 'link_in_bio'
  | 'follow_me'
  | 'check_out_mine'
  | 'contact_me'
  | 'sales_pitch'
  | 'price';

export type PromoResult = {
  /** Enough signal to warrant a warning (comments) or review (posts). */
  isPromo: boolean;
  signals: PromoSignal[];
};

const NONE: PromoResult = { isPromo: false, signals: [] };

// Laybell's own links are not self-promotion — pointing someone at a Laybell
// profile or post is using the app, not routing around it.
const OWN_HOSTS = /(^|\.)(laybell\.app|open\.laybell\.app)$/i;

function hasExternalLink(text: string): boolean {
  for (const raw of extractUrls(text)) {
    try {
      const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname;
      if (!OWN_HOSTS.test(host)) return true;
    } catch {
      return true; // unparseable but link-shaped — still a pointer off-platform
    }
  }
  return false;
}

// Each pattern is anchored on a first-person promotional claim. "check out this
// song" is someone recommending music; "check out MY song" is an ad. The
// possessive is what separates them, so every pattern below requires one.
const PATTERNS: { signal: PromoSignal; re: RegExp }[] = [
  { signal: 'link_in_bio', re: /\b(link|links)\s+(in|on)\s+(my\s+)?(bio|profile|description)\b/i },
  { signal: 'follow_me', re: /\b(follow|sub(scribe)?|add)\s+(me|my|back)\b/i },
  { signal: 'check_out_mine', re: /\b(check|checkout|peep|listen\s+to|stream|watch|hear)\s+(out\s+)?(my|our)\b/i },
  // Two shapes, because "hmu" and "hit me up" already carry their object —
  // requiring a trailing me/us the way the transitive verbs do made them
  // unmatchable ("hit me up me").
  { signal: 'contact_me', re: /\b(dm|pm|message|text|whatsapp)\s+(me|us)\b|\b(hmu|hit\s+me\s+up)\b/i },
  { signal: 'sales_pitch', re: /\b(buy|order|shop|book|hire|available)\s+(now|here|today)\b|\b(hire|book)\s+(me|us)\b|\b(promo|discount|deal)\s+code\b|\bfor\s+sale\b/i },
  { signal: 'price', re: /(^|\s)[$£€]\s?\d/ },
];

function textSignals(text: string): PromoSignal[] {
  const out: PromoSignal[] = [];
  for (const p of PATTERNS) if (p.re.test(text)) out.push(p.signal);
  return out;
}

/**
 * A COMMENT on someone else's post.
 *
 * `isOwnPost` is the fairness carve-out the Guidelines promise in §9: on your
 * own post you are answering questions about your own work, which the rule
 * explicitly permits. Never warn there.
 *
 * Threshold is two independent signals, or one link-shaped signal paired with
 * promotional wording. A bare "follow me" between friends does not trip it;
 * "follow me, link in bio" does.
 */
export function detectCommentPromo(text: string, isOwnPost: boolean): PromoResult {
  const body = (text ?? '').trim();
  if (!body || isOwnPost) return NONE;

  const signals = textSignals(body);
  if (hasExternalLink(body)) signals.unshift('external_link');
  if (!signals.length) return NONE;

  const linky = signals.includes('external_link') || signals.includes('link_in_bio');
  const isPromo = signals.length >= 2 || (linky && signals.length >= 1 && signals[0] !== 'price');
  return { isPromo, signals };
}

/**
 * A POST that reads like an ad. Only ever raises a review flag — §10 requires a
 * person to decide before any limit lands, so this deliberately returns no
 * severity a caller could act on directly.
 *
 * Stricter than the comment check (three signals, or a link plus a pitch),
 * because the cost of a wrong guess is a moderator's time on a real creator's
 * ordinary post.
 */
export function detectPostPromo(caption: string): PromoResult {
  const body = (caption ?? '').trim();
  if (!body) return NONE;

  const signals = textSignals(body);
  if (hasExternalLink(body)) signals.unshift('external_link');
  if (!signals.length) return NONE;

  const linky = signals.includes('external_link');
  const pitchy = signals.includes('sales_pitch') || signals.includes('price');
  const isPromo = signals.length >= 3 || (linky && pitchy);
  return { isPromo, signals };
}
