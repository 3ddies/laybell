import { useRef } from 'react';
import { ScrollView, type ScrollViewProps } from 'react-native';

// A horizontal rail inside a page that already answers horizontal swipes itself
// (Music's pills, a profile's sub-tabs). Same-axis gestures can't be told apart,
// so the rail declares itself out through onGuardStart/onGuardEnd — but ONLY while
// it can actually scroll (content wider than its frame). A rail with one or two
// cards, or empty space across the rest of the row, lets the page's swipes pass
// straight through instead of dead-zoning the row.
//
// Rails that can come up short should also pass alwaysBounceHorizontal={false}:
// iOS rubber-bands a horizontal ScrollView even when its content fits, so the row
// would wobble under a swipe it isn't taking.
type Props = ScrollViewProps & {
  onGuardStart: () => void;
  onGuardEnd: () => void;
};

export default function GuardedRail({ onGuardStart, onGuardEnd, ...props }: Props) {
  const frameW = useRef(0);
  const contentW = useRef(0);
  const guarding = useRef(false);
  // Cleared on end AND cancel: a rail that loses its touch gets a cancel, and a
  // guard left standing would silently switch the page's swipes off.
  const release = () => {
    if (guarding.current) { guarding.current = false; onGuardEnd(); }
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      {...props}
      onLayout={(e) => { frameW.current = e.nativeEvent.layout.width; props.onLayout?.(e); }}
      onContentSizeChange={(w, h) => { contentW.current = w; props.onContentSizeChange?.(w, h); }}
      onTouchStart={(e) => {
        if (contentW.current > frameW.current + 1) { guarding.current = true; onGuardStart(); }
        props.onTouchStart?.(e);
      }}
      onTouchEnd={(e) => { release(); props.onTouchEnd?.(e); }}
      onTouchCancel={(e) => { release(); props.onTouchCancel?.(e); }}
    />
  );
}
