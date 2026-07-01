import React, { createContext, useContext, useState, useCallback } from 'react';

// A global "pause all background media" switch. Full-screen takeover UIs (e.g. the
// GIF maker) suspend playback while they're open so a post's video/audio doesn't
// keep playing behind them; every AppVideo consults this and pauses when suspended
// (unless it opts out with `ignoreSuspend`). Ref-counted so nested/overlapping
// suspenders compose correctly — playback resumes only when the last one releases.
type MediaSuspendType = {
  suspended: boolean;
  suspend: () => void;   // increment the suspend count
  resume: () => void;    // decrement it
};

const Ctx = createContext<MediaSuspendType>({ suspended: false, suspend: () => {}, resume: () => {} });

export function MediaSuspendProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const suspend = useCallback(() => setCount((c) => c + 1), []);
  const resume = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  return <Ctx.Provider value={{ suspended: count > 0, suspend, resume }}>{children}</Ctx.Provider>;
}

// Safe outside a provider (returns the never-suspended default).
export function useMediaSuspend() {
  return useContext(Ctx);
}
