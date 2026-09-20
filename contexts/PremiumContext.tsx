import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isPremium as readPremium, isPremiumPlus as readPremiumPlus, subscribePremium } from '../lib/entitlements';
import { afterHomePaint } from '../lib/startupGate';
import {
  initPurchases, getPackages, purchase as doPurchase, restore as doRestore,
  purchasesConfigured, type Pkg,
} from '../lib/purchases';

// React surface over the RevenueCat wrapper + the module-level premium flag. UI
// (the paywall, Settings) reads isPremium/packages and calls purchase/restore;
// non-UI code (lib/ads, the offline engine) reads the module flag directly.

type PremiumContextValue = {
  isPremium: boolean;
  isPremiumPlus: boolean;         // the $19.99 tier — Films + badge freeze
  packages: Pkg[];
  configured: boolean;            // real billing wired up (keys present)?
  loading: boolean;
  purchase: (pkg: Pkg) => Promise<'ok' | 'cancelled' | 'error'>;
  restore: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

const PremiumContext = createContext<PremiumContextValue>({
  isPremium: false, isPremiumPlus: false, packages: [], configured: false, loading: false,
  purchase: async () => 'error', restore: async () => false, refresh: async () => {},
});

export function usePremium() { return useContext(PremiumContext); }

export function PremiumProvider({ children }: { children: React.ReactNode }) {
  const [isPremiumState, setIsPremiumState] = useState(readPremium());
  const [isPlusState, setIsPlusState] = useState(readPremiumPlus());
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(false);

  // Mirror the module-level flags (set by purchases.ts via RevenueCat). One
  // subscription covers both tiers — the listener re-reads both.
  useEffect(() => subscribePremium(() => {
    setIsPremiumState(readPremium());
    setIsPlusState(readPremiumPlus());
  }), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
    // getSession (on the phone), not getUser (a round trip) — see app/(tabs)/index.tsx.
      const { data: { session } } = await supabase.auth.getSession();
      await initPurchases(session?.user?.id ?? null);
      // The entitlement (above) gates ads, so it resolves now. The price list is
      // only ever read by the paywall, and fetching it at launch put a store
      // round trip next to the feed's first load — it waits for Home's paint.
      afterHomePaint().then(async () => {
        try { setPackages(await getPackages()); } catch {}
      });
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  const purchase = useCallback((pkg: Pkg) => doPurchase(pkg), []);
  const restore = useCallback(() => doRestore(), []);

  return (
    <PremiumContext.Provider
      value={{ isPremium: isPremiumState, isPremiumPlus: isPlusState, packages, configured: purchasesConfigured(), loading, purchase, restore, refresh }}
    >
      {children}
    </PremiumContext.Provider>
  );
}
