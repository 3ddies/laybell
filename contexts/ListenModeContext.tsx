import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

// Listen mode — distraction-free listening on the Music tab. While active:
//  • the bottom tab bar fades away ((tabs)/_layout.tsx) and tab swiping is
//    locked, so the user stays on Music until they exit;
//  • the mini-player slides down into the space the bar vacated (MiniPlayer);
//  • foreground push notifications are fully suppressed (useNotifications) —
//    no banners, sounds, or badges while the user listens in peace.
// Session-only by design: the mode never persists across app launches.
//
// Leaving the mode: the listener can browse WHILE listening (music keeps playing
// through the docked mini-player on a pushed profile, etc.), so ordinary
// navigation keeps the session alive. But two kinds of exit are forced so the
// app can never be left half-in-Listen-mode on a screen that doesn't understand
// it: (1) IMMERSIVE surfaces (reels, stories, livestreams) own the whole screen
// and audio and can't host the mini-player — `confirmLeaveListen` warns before
// entering one, and a route-level backstop in app/_layout force-exits if any
// path reaches one anyway; (2) incidental popups that jump to an unrelated
// screen (e.g. the badge-upgrade toast → /badges) just call `setListenMode(false)`
// on their way out.

type ListenModeValue = {
  listenMode: boolean;
  setListenMode: (on: boolean) => void;
  // Gate for opening an IMMERSIVE surface (a reel, a livestream) from within a
  // listen session. Shows a themed confirm (ListenLeaveConfirm) first and only
  // proceeds — after switching Listen mode off — if the user accepts; when
  // Listen mode is off it just runs the action. Funnelling every such entry
  // through one path is what stops a stray one from stranding the app in Listen
  // mode on an incompatible screen.
  confirmLeaveListen: (proceed: () => void) => void;
};

// Module-level mirror so non-React code can read the flag — specifically the
// expo-notifications foreground handler, which runs outside the component tree.
let listenModeFlag = false;
export function isListenModeActive(): boolean {
  return listenModeFlag;
}

// Bridge to the themed confirm modal (ListenLeaveConfirm, mounted low in the app
// overlays). The provider sits high in the tree — near the app root — so holding
// the modal's open/close state on it would re-render the whole app each time it
// toggled. Instead the modal registers a handler here and the provider just
// calls it, keeping the context value perfectly stable.
let leaveConfirmHandler: ((proceed: () => void) => void) | null = null;
export function setLeaveConfirmHandler(h: ((proceed: () => void) => void) | null) {
  leaveConfirmHandler = h;
}

const ListenModeContext = createContext<ListenModeValue>({
  listenMode: false,
  setListenMode: () => {},
  confirmLeaveListen: (proceed) => proceed(),
});

export function ListenModeProvider({ children }: { children: ReactNode }) {
  const [listenMode, setListenModeState] = useState(false);
  const setListenMode = useCallback((on: boolean) => {
    listenModeFlag = on;
    setListenModeState(on);
  }, []);

  // Reads the always-current module flag (not the `listenMode` state) so the
  // callback identity is stable and never fires against a stale value.
  const confirmLeaveListen = useCallback((proceed: () => void) => {
    if (!listenModeFlag) { proceed(); return; }
    if (leaveConfirmHandler) leaveConfirmHandler(proceed);
    // Fallback if the modal isn't mounted yet (shouldn't happen in the live app):
    // never swallow the tap — exit Listen mode and proceed.
    else { setListenMode(false); proceed(); }
  }, [setListenMode]);

  return (
    <ListenModeContext.Provider value={{ listenMode, setListenMode, confirmLeaveListen }}>
      {children}
    </ListenModeContext.Provider>
  );
}

export function useListenMode(): ListenModeValue {
  return useContext(ListenModeContext);
}
