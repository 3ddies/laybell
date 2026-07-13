import * as MediaLibrary from 'expo-media-library';

// Session cache for MediaLibrary.getAssetInfoAsync resolutions (asset id →
// usable file:// uri). getAssetInfoAsync is the SLOW step of picking media —
// for iCloud-optimized libraries it downloads the full original — and both the
// composer grid and the attachment picker were paying it again on every re-pick
// of the same asset. localUri paths are stable for a session; NOT persisted
// across launches (iOS can invalidate them).
const cache = new Map<string, string>();

export async function resolveAssetUri(asset: MediaLibrary.Asset): Promise<string> {
  const hit = cache.get(asset.id);
  if (hit) return hit;
  const info = await MediaLibrary.getAssetInfoAsync(asset);
  const uri = info.localUri || asset.uri;
  cache.set(asset.id, uri);
  return uri;
}

// iOS can invalidate a cached localUri if the user deletes/edits the asset
// mid-session — callers evict on a failed pick so the next tap resolves fresh.
export function evictAssetUri(id: string): void {
  cache.delete(id);
}
