// App-wide "unlock this feature" prompt — the tiny event bus behind PremiumGateHost.
//
// Any gated feature calls openPremiumGate({ feature, tier }) and the host (mounted once
// at the root) pops an attractive card naming the feature, the tier it needs, and a
// button straight to the paywall. A module-level emitter (not a context) so BOTH UI and
// non-UI code can trigger it, exactly like lib/ShareContext's openShareGlobal.

export type PremiumGateOpts = {
  /** The feature being unlocked, e.g. "Pro DJ Booth" — shown as the card's title. */
  feature: string;
  /** Which tier unlocks it. Defaults to 'premium'. */
  tier?: 'premium' | 'premiumPlus';
  /** One-line pitch under the title; a sensible default is used when omitted. */
  blurb?: string;
  /**
   * For features that are EARNED rather than bought (e.g. Record & Post, which is free
   * at Gold badge status). When set, the card leads with the badge — gold theme, trophy,
   * "earn it" copy, and a button to the badges screen — instead of a Premium pitch.
   */
  badge?: 'gold';
};

type Listener = (opts: PremiumGateOpts) => void;

let listener: Listener | null = null;

/** Show the unlock prompt for a gated feature. No-op if the host isn't mounted yet. */
export function openPremiumGate(opts: PremiumGateOpts): void {
  listener?.(opts);
}

/** PremiumGateHost subscribes here. Only one host is mounted (at the app root). */
export function subscribePremiumGate(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}
