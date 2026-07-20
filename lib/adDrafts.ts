import AsyncStorage from '@react-native-async-storage/async-storage';

// Ad-campaign draft — a LOCAL (AsyncStorage) snapshot of the whole in-progress
// Ad Manager creation flow, so exiting mid-build and coming back resumes at the
// exact step with everything filled in. Mirrors lib/drafts (post composer): only
// the FORM state is saved — nothing is uploaded or written to the DB until the
// user actually launches. Media picks keep their local file:// uris (may go
// stale if the OS clears the cache, in which case the user just re-picks that
// slot). One draft at a time (a single resume), cleared on a successful launch.

const KEY = 'ad_draft_v1';

// Loosely typed for the media-carrying fields (businessAvatar / drafts hold the
// create screen's Pick/CreativeDraft shapes) so this stays decoupled from the UI.
export type AdDraft = {
  step: string;
  objective: string;
  advertiserName: string;
  isBusiness: boolean;
  businessAvatar: any | null;
  placements: string[];
  drafts: Record<string, any>;
  ageMin: string;
  ageMax: string;
  gender: string;
  genres: string[];
  useLocation: boolean;
  radiusKm: string;
  budget: string;
  dailyCap: string;
  cpm: string;
  days: string;
  savedAt: number;
};

export async function saveAdDraft(state: Omit<AdDraft, 'savedAt'>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch { /* best effort — a failed save just means no resume */ }
}

export async function loadAdDraft(): Promise<AdDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AdDraft) : null;
  } catch {
    return null;
  }
}

export async function clearAdDraft(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Worth offering a resume? Only if the user got past the first screen or
    entered anything real — a blank draft shouldn't nag them. */
export function isMeaningfulAdDraft(d: AdDraft | null): boolean {
  if (!d) return false;
  return (
    d.step !== 'basics' ||
    !!d.advertiserName?.trim() ||
    (d.placements?.length ?? 0) > 0 ||
    Object.keys(d.drafts ?? {}).length > 0 ||
    d.isBusiness
  );
}
