import { useEffect, useState } from 'react';
import { bakeFilter } from './filterSkia';
import type { FilterKey } from './filters';

// React Native's `filter` style doesn't render color effects on iOS, so color filters are
// BAKED into the pixels with Skia (lib/filterSkia — GPU, fast). This hook bakes a single
// image through the chosen filter for a live preview: it returns the baked uri once ready
// (the original meanwhile, so nothing flashes blank) and a `baking` flag for a spinner.
// `width` keeps preview bakes small + fast. 'original' is a no-op.
export function useFilteredUri(
  uri: string | null | undefined,
  filterKey: FilterKey,
  width: number,
): { uri: string | null; baking: boolean } {
  const [out, setOut] = useState<string | null>(uri ?? null);
  const [baking, setBaking] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!uri || filterKey === 'original') { setOut(uri ?? null); setBaking(false); return; }
    setBaking(true);
    bakeFilter(uri, filterKey, width)
      .then((r) => { if (alive) { setOut(r); setBaking(false); } })
      .catch(() => { if (alive) { setOut(uri); setBaking(false); } });
    return () => { alive = false; };
  }, [uri, filterKey, width]);

  return { uri: out, baking };
}
