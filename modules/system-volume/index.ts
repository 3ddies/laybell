import { requireOptionalNativeModule } from 'expo';
import { useEffect, useState } from 'react';

// The device's output volume, 0–1, so an in-app fader can follow the hardware
// buttons rather than sitting beside them doing its own thing.
//
// requireOptionalNativeModule, NOT requireNativeModule: this ships in a native
// build, and JS is frozen at build time on this project (no expo-updates). A
// hard require would crash every screen that imports this on any binary built
// before the module existed — including the current TestFlight one. Optional
// means an older build simply never syncs, and everything else still works.
const Native = requireOptionalNativeModule<{
  getVolume(): Promise<number>;
  addListener(event: 'onVolumeChange', cb: (e: { volume: number }) => void): { remove(): void };
}>('SystemVolume');

export const systemVolumeAvailable = () => !!Native;

export async function getSystemVolume(): Promise<number | null> {
  if (!Native) return null;
  try { return await Native.getVolume(); } catch { return null; }
}

/**
 * The live system volume, or null where the native module is missing.
 *
 * READ-ONLY by design. iOS has no supported API to set the system volume, and
 * the MPVolumeView workaround is a review risk — so this is one-way: the phone
 * moves the app, never the reverse.
 */
export function useSystemVolume(): number | null {
  const [volume, setVolume] = useState<number | null>(null);
  useEffect(() => {
    if (!Native) return;
    let alive = true;
    Native.getVolume().then((v) => { if (alive) setVolume(v); }).catch(() => {});
    const sub = Native.addListener('onVolumeChange', (e) => {
      if (alive && typeof e?.volume === 'number') setVolume(e.volume);
    });
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return volume;
}
