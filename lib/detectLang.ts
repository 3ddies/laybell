// Lightweight, network-free language guess for a snippet of user-typed text.
// Used to decide whether to OFFER "tap to translate": we only show it for text
// that is confidently a real language DIFFERENT from the viewer's — never for
// gibberish, single ambiguous words, or text already in the viewer's language.
//
// This is deliberately a heuristic (no dependency, OTA-safe), not a full
// detector: it recognises the app's own languages plus other non-Latin scripts.
// It returns an app language code, the sentinel 'foreign' (a real but
// non-app-Latin script, e.g. Arabic/Korean), or null (can't tell -> no offer).

// Non-Latin scripts map cleanly to a language (or to 'foreign' for ones outside
// the app set). Checked before stopwords since scripts are unambiguous.
function scriptLang(text: string): string | null {
  if (/[぀-ヿ]/.test(text)) return 'ja';                  // Hiragana / Katakana
  if (/[㐀-䶿一-鿿]/.test(text)) return 'zh';     // Han (after the Kana check)
  if (/[ऀ-ॿ]/.test(text)) return 'hi';                 // Devanagari
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';                 // Cyrillic
  // Other clearly-foreign scripts (Arabic, Hebrew, Thai, Hangul, Greek): a real
  // language outside the Latin app set — always worth offering a translation.
  if (/[؀-ۿ֐-׿฀-๿가-힯Ͱ-Ͽ]/.test(text)) return 'foreign';
  return null;
}

// Common function words for the Latin-script app languages. The dominant set
// across the text's words decides the language. Distinctive words (the/el/le/
// der/o/il …) carry the signal; shared words add noise but rarely flip a winner.
// Stored without accents (input is de-accented before matching).
const STOP: Record<string, Set<string>> = {
  en: new Set(['the', 'and', 'is', 'are', 'was', 'were', 'you', 'your', 'to', 'of', 'in', 'on', 'at', 'it', 'that', 'this', 'for', 'with', 'have', 'has', 'not', 'but', 'they', 'we', 'what', 'all', 'can', 'just', 'like', 'about', 'out', 'if', 'do', 'does', 'get', 'how', 'when', 'there', 'from', 'will', 'would', 'i', 'my', 'me', 'so', 'no']),
  es: new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'no', 'se', 'su', 'sus', 'lo', 'le', 'mas', 'pero', 'como', 'este', 'esta', 'muy', 'si', 'soy', 'eres', 'son', 'tambien', 'porque', 'cuando', 'todo', 'nada', 'bien', 'yo', 'tu', 'mi']),
  fr: new Set(['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'que', 'qui', 'dans', 'pour', 'pas', 'vous', 'je', 'tu', 'il', 'elle', 'nous', 'est', 'sont', 'sur', 'avec', 'mais', 'ce', 'cette', 'plus', 'tres', 'bien', 'tout', 'quoi', 'comme', 'aussi', 'au', 'aux', 'mon', 'ma', 'sa']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'sind', 'war', 'ein', 'eine', 'einen', 'zu', 'den', 'dem', 'des', 'mit', 'auf', 'nicht', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'aber', 'auch', 'fur', 'von', 'wie', 'was', 'noch', 'nur', 'schon', 'sehr', 'mehr', 'im', 'am', 'mein', 'dein']),
  pt: new Set(['o', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'que', 'em', 'um', 'uma', 'por', 'com', 'para', 'nao', 'se', 'seu', 'sua', 'mais', 'mas', 'como', 'esta', 'muito', 'tambem', 'porque', 'quando', 'tudo', 'nada', 'bem', 'voce', 'eu', 'ele', 'ela', 'meu', 'minha', 'sao', 'foi', 'isso']),
  it: new Set(['il', 'lo', 'la', 'gli', 'le', 'di', 'che', 'e', 'in', 'un', 'una', 'per', 'con', 'non', 'si', 'piu', 'ma', 'come', 'questo', 'questa', 'molto', 'anche', 'perche', 'quando', 'tutto', 'bene', 'sono', 'sei', 'cosi', 'dove', 'io', 'tu', 'lui', 'lei', 'mio', 'mia', 'al', 'del', 'sul']),
};

// The app language (or 'foreign'/null) the text appears to be written in.
export function detectLang(input?: string | null): string | null {
  const text = (input ?? '').trim();
  if (text.length < 3) return null;

  const s = scriptLang(text);
  if (s) return s;

  // Latin script: tally common-word hits per language; a clear winner wins.
  // Accents are stripped so "está"/"esta" and "perché"/"perche" both match.
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(Boolean);
  if (words.length < 2) return null; // too short to judge a Latin language

  const scores: Record<string, number> = { en: 0, es: 0, fr: 0, de: 0, pt: 0, it: 0 };
  for (const w of words) {
    for (const code in STOP) if (STOP[code].has(w)) scores[code]++;
  }

  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  for (const code in scores) {
    if (scores[code] > bestScore) { second = bestScore; bestScore = scores[code]; best = code; }
    else if (scores[code] > second) { second = scores[code]; }
  }

  // Need a real signal AND a clear winner (no stopword hits or a tie -> unsure).
  if (!best || bestScore === 0 || bestScore === second) return null;
  return best;
}
