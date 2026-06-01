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
