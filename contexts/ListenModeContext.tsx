import { createContext, useContext, useState, type ReactNode } from 'react';

// Listen mode — distraction-free listening on the Music tab. While active:
//  • the bottom tab bar fades away ((tabs)/_layout.tsx) and tab swiping is
//    locked, so the user stays on Music until they exit;
//  • the mini-player slides down into the space the bar vacated (MiniPlayer);
//  • foreground push notifications are fully suppressed (useNotifications) —
//    no banners, sounds, or badges while the user listens in peace.
// Session-only by design: the mode never persists across app launches.

type ListenModeValue = {
  listenMode: boolean;
  setListenMode: (on: boolean) => void;
};

// Module-level mirror so non-React code can read the flag — specifically the
// expo-notifications foreground handler, which runs outside the component tree.
let listenModeFlag = false;
export function isListenModeActive(): boolean {
  return listenModeFlag;
}

const ListenModeContext = createContext<ListenModeValue>({
  listenMode: false,
  setListenMode: () => {},
});

export function ListenModeProvider({ children }: { children: ReactNode }) {
  const [listenMode, setListenModeState] = useState(false);
  const setListenMode = (on: boolean) => {
    listenModeFlag = on;
    setListenModeState(on);
  };
  return (
    <ListenModeContext.Provider value={{ listenMode, setListenMode }}>
      {children}
    </ListenModeContext.Provider>
  );
}

export function useListenMode(): ListenModeValue {
  return useContext(ListenModeContext);
}
