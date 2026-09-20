// Last-seen data for screens people open again and again — a profile, an Explore
// genre — so a revisit paints at once and refreshes behind it (stale-while-revalidate,
// the pattern that makes Instagram's screens feel instant). 1.0.4.
//
// In memory only: it lasts as long as the app process, and clearScreenCaches()
// empties every cache when the signed-in account changes (app/_layout), so one
// account never sees another's data. Each cache is a small LRU, so a long session
// can't grow it without bound. Pure — tested in scripts/tests/test-screencache.mjs.

export type ScreenCache<T> = {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
};

const everyCache = new Set<{ clear(): void }>();

export function createScreenCache<T>(max: number): ScreenCache<T> {
  const map = new Map<string, T>();
  const cache: ScreenCache<T> = {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as T;
      // Re-insert: a Map iterates in insertion order, so this marks it most recent.
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    delete(key) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
  everyCache.add(cache);
  return cache;
}

/** Empties every screen cache — called when the signed-in account changes. */
export function clearScreenCaches(): void {
  everyCache.forEach((c) => c.clear());
}
