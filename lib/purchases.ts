import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { setPremium } from './entitlements';

// RevenueCat wrapper. react-native-purchases is a NATIVE module, loaded DYNAMICALLY
// with a graceful fallback (like lib/network.ts) so this ships ahead of the native
// rebuild: pre-rebuild every call no-ops and premium stays false. Keys + entitlement
// id come from app.json `extra.revenuecat`; until those are filled in (see
// docs/PHASE_C_SETUP.md) we never configure, so the app behaves exactly as before.

type RCConfig = { iosApiKey?: string; androidApiKey?: string; entitlement?: string };
const cfg: RCConfig = ((Constants.expoConfig?.extra as any)?.revenuecat) ?? {};
const ENTITLEMENT = cfg.entitlement || 'premium';

export type Pkg = { identifier: string; priceString: string; title: string; description: string; raw: any };

let modPromise: Promise<any | null> | null = null;
function load(): Promise<any | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (!modPromise) {
    modPromise = import('react-native-purchases')
      .then((m: any) => m?.default ?? m ?? null)
      .catch(() => null);   // module not in this build yet → graceful fallback
  }
  return modPromise;
}

function apiKey(): string | null {
  const k = Platform.OS === 'ios' ? cfg.iosApiKey : cfg.androidApiKey;
  return k && k.length > 0 ? k : null;
}

// True when the configured premium entitlement is active in the customer info.
function activeFromInfo(info: any): boolean {
  return !!info?.entitlements?.active?.[ENTITLEMENT];
}

let configured = false;
let listenerAttached = false;

// Configure RevenueCat for the signed-in user and reflect entitlement status into
// lib/entitlements. Idempotent; no-ops without API keys or the native module.
export async function initPurchases(userId: string | null): Promise<void> {
  const key = apiKey();
  if (!key) return;                  // keys not set yet → stay on the free tier
  const Purchases = await load();
  if (!Purchases) return;            // native module not in this build yet
  try {
    if (!configured) {
      Purchases.configure({ apiKey: key, appUserID: userId ?? undefined });
      configured = true;
    } else if (userId) {
      try { await Purchases.logIn(userId); } catch {}
    }
    if (!listenerAttached) {
      Purchases.addCustomerInfoUpdateListener((info: any) => setPremium(activeFromInfo(info)));
      listenerAttached = true;
    }
    const info = await Purchases.getCustomerInfo();
    setPremium(activeFromInfo(info));
  } catch {}
}

export async function getPackages(): Promise<Pkg[]> {
  const Purchases = await load();
  if (!Purchases) return [];
  try {
    const offerings = await Purchases.getOfferings();
    const pkgs = offerings?.current?.availablePackages ?? [];
    return pkgs.map((p: any) => ({
      identifier: p.identifier,
      priceString: p.product?.priceString ?? '',
      title: p.product?.title ?? '',
      description: p.product?.description ?? '',
      raw: p,
    }));
  } catch { return []; }
}

// 'ok' | 'cancelled' | 'error'. Premium also updates via the customer-info listener.
export async function purchase(pkg: Pkg): Promise<'ok' | 'cancelled' | 'error'> {
  const Purchases = await load();
  if (!Purchases) return 'error';
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg.raw);
    setPremium(activeFromInfo(customerInfo));
    return 'ok';
  } catch (e: any) {
    if (e?.userCancelled) return 'cancelled';
    return 'error';
  }
}

export async function restore(): Promise<boolean> {
  const Purchases = await load();
  if (!Purchases) return false;
  try {
    const info = await Purchases.restorePurchases();
    const active = activeFromInfo(info);
    setPremium(active);
    return active;
  } catch { return false; }
}

// Whether real billing is wired up (keys present). The paywall uses this to show a
// "coming soon" state instead of a broken purchase button during preview.
export function purchasesConfigured(): boolean { return !!apiKey(); }

export async function logOutPurchases(): Promise<void> {
  const Purchases = await load();
  if (!Purchases || !configured) return;
  try { await Purchases.logOut(); } catch {}
  setPremium(false);
}
