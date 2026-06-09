import { createContext, useContext } from 'react';

// True while a tab swipe gesture is in progress (between the navigator's
// swipeStart and swipeEnd events). Screens use this to defer work that
// shouldn't happen mid-swipe — e.g. autoplaying feed videos until the page
// settles, or letting the post caption input grab focus (which pops the
// keyboard) when a finger drags across it.
export const PagerContext = createContext<boolean>(false);

export function usePagerSwiping() {
  return useContext(PagerContext);
}

// Lets a deep child temporarily turn the tab navigator's swipe off/on — e.g. a
// horizontal slideshow carousel disables it while you swipe between slides so the
// gesture doesn't bubble up and change tabs. Default is a no-op (outside the tabs,
// e.g. the full-screen post viewer, there's no tab swiper to control).
export const TabSwipeContext = createContext<(enabled: boolean) => void>(() => {});

export function useTabSwipeControl() {
  return useContext(TabSwipeContext);
}
