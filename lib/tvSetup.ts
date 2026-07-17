import AsyncStorage from '@react-native-async-storage/async-storage';

// Laybell TV — "Watch on TV" setup directory. Powers the friendly in-app
// connect wizard (components/TVConnectModal): the user picks their TV from this
// list once, we remember it, and the wizard offers the transport(s) that
// actually work for their TV + phone combo:
//
//   iPhone  → AirPlay first (Apple TV + the AirPlay-2 sets most people own),
//             Google Cast as a secondary when the TV supports both.
//   Android → Google Cast only (AirPlay is Apple-to-Apple).
//
// Capabilities reflect RECENT models (roughly 2019+) — the wizard's trouble
// footer covers older sets. Brand names are proper nouns and stay untranslated;
// only the "Not sure" card goes through i18n (label: null → t('tv.setup.notSure')).

export type TVTransport = 'airplay' | 'cast';

export type TVBrand = {
  id: string;
  /** Display name, or null for the i18n'd "Not sure / other" card. */
  label: string | null;
  /** Ionicons glyph for the picker card. */
  icon: string;
  airplay: boolean;
  cast: boolean;
};

export const TV_BRANDS: TVBrand[] = [
  { id: 'appletv', label: 'Apple TV', icon: 'logo-apple', airplay: true, cast: false },
  { id: 'samsung', label: 'Samsung', icon: 'tv-outline', airplay: true, cast: false },
  { id: 'lg', label: 'LG', icon: 'tv-outline', airplay: true, cast: false },
  { id: 'sony', label: 'Sony', icon: 'tv-outline', airplay: true, cast: true },
  { id: 'vizio', label: 'Vizio', icon: 'tv-outline', airplay: true, cast: true },
  { id: 'roku', label: 'Roku', icon: 'tv-outline', airplay: true, cast: false },
  { id: 'googletv', label: 'Google TV / Chromecast', icon: 'logo-google', airplay: false, cast: true },
  // "Not sure" claims both so the wizard just leads with the phone's native
  // transport — the way that works with the most TVs for that phone.
  { id: 'other', label: null, icon: 'help-circle-outline', airplay: true, cast: true },
];

export function brandById(id: string | null | undefined): TVBrand | null {
  return TV_BRANDS.find((b) => b.id === id) ?? null;
}

/**
 * The connection methods to offer, best-first, for this TV + phone combo.
 * Empty means the combo can't connect (e.g. Android phone + AirPlay-only TV) —
 * the wizard shows guidance instead of a Connect button.
 */
export function transportsFor(brand: TVBrand, os: string): TVTransport[] {
  const list: TVTransport[] = [];
  if (os === 'ios') {
    if (brand.airplay) list.push('airplay');
    if (brand.cast) list.push('cast');
  } else if (brand.cast) {
    list.push('cast');
  }
  return list;
}

// ── Remembered choice — the wizard skips the brand grid on the next open. ─────

const BRAND_KEY = 'laybell.tv.brand';

export async function loadSavedBrandId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(BRAND_KEY);
  } catch {
    return null;
  }
}

export function saveBrandId(id: string): void {
  AsyncStorage.setItem(BRAND_KEY, id).catch(() => {});
}
