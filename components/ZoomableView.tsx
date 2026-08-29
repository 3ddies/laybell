import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import {
  PinchGestureHandler, PanGestureHandler, State,
  type PinchGestureHandlerStateChangeEvent, type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';

// Pinch-to-zoom that STAYS zoomed, with smooth one-finger pan while zoomed.
//
// The whole Animated transform graph is built ONCE and never recreated — the zoom
// bounds live in Animated.Values (not React state feeding an interpolation), so
// changing zoom level never rebuilds a node. Recreating clamp nodes on the fly was
// corrupting the native animation graph, which is what made the pan turn choppy
// after hitting a rubber-band limit or a reactive edge. Emits a "locked" flag via
// onZoomChange for the whole zoom interaction. No reanimated dependency.
const MAX_SCALE = 5;
const FACTOR_IN = 0.85;
const FACTOR_OUT = 0.85;
const OVERZOOM_FLOOR = 0.7;
const FIT_EPSILON = 1.08;
const COOLDOWN_MS = 160;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function dampGesture(raw: number): number {
  const r = clamp(raw, 0.2, 6);
  return r >= 1 ? 1 + (r - 1) * FACTOR_IN : 1 + (r - 1) * FACTOR_OUT;
}

export default function ZoomableView({
  width, height, active = true, style, onZoomChange, onGesture, resetOnRelease = false, children,
}: {
  width: number;
  height: number;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  onZoomChange?: (locked: boolean) => void;
  /** Fires the moment a pinch or pan actually activates (any zoom level), so the
   *  parent can tell a tap apart from a zoom movement. */
  onGesture?: () => void;
  /** Springs back to fit the moment the pinch ends, instead of staying zoomed.
   *
   *  For a viewer, holding the zoom is right — you got there to look around, and
   *  one finger then pans. Inside a SCROLLING FEED it is a trap: holding the zoom
   *  also means enabling the one-finger pan, which swallows the drag the user
   *  needs to scroll the list, and a post left zoomed as it scrolls out of view
   *  is a state nobody asked for. A peek that lets go is the right feed gesture,
   *  and it keeps the pan handler disabled entirely. */
  resetOnRelease?: boolean;
  children: ReactNode;
}) {
  const baseScale = useRef(new Animated.Value(1)).current;
  const pinchScale = useRef(new Animated.Value(1)).current;
  const baseTX = useRef(new Animated.Value(0)).current;
  const baseTY = useRef(new Animated.Value(0)).current;
  const panTX = useRef(new Animated.Value(0)).current;
  const panTY = useRef(new Animated.Value(0)).current;
  // Live pan bounds as Animated.Values (kept ≥1 to avoid divide-by-zero). Updated
  // by setValue on zoom changes — NEVER by rebuilding a node.
  const boundsX = useRef(new Animated.Value(1)).current;
  const boundsY = useRef(new Animated.Value(1)).current;

  // Display scale: damped pinch × base, mapped through the display curve
  // (rubber-band below fit, identity to MAX). Built once.
  const scale = useMemo(() => Animated.multiply(
    baseScale,
    pinchScale.interpolate({
      inputRange: [0.2, 1, 6],
      outputRange: [1 + (0.2 - 1) * FACTOR_OUT, 1, 1 + (6 - 1) * FACTOR_IN],
      extrapolate: 'clamp',
    }),
  ).interpolate({
    inputRange: [0, 1, MAX_SCALE], outputRange: [OVERZOOM_FLOOR, 1, MAX_SCALE], extrapolate: 'clamp',
  }), [baseScale, pinchScale]);

  // Hard clamp to ±bounds, built once: clamp(v, -b, b) = b · clamp(v/b, -1, 1).
  // The fixed [-1,1] interpolation is stable; b is an Animated.Value.
  const translateX = useMemo(() => Animated.multiply(
    boundsX,
    Animated.divide(Animated.add(baseTX, panTX), boundsX).interpolate({
      inputRange: [-1, 1], outputRange: [-1, 1], extrapolate: 'clamp',
    }),
  ), [baseTX, panTX, boundsX]);
  const translateY = useMemo(() => Animated.multiply(
    boundsY,
    Animated.divide(Animated.add(baseTY, panTY), boundsY).interpolate({
      inputRange: [-1, 1], outputRange: [-1, 1], extrapolate: 'clamp',
    }),
  ), [baseTY, panTY, boundsY]);

  // JS mirrors of the committed transform.
  const curScale = useRef(1);
  const curTX = useRef(0);
  const curTY = useRef(0);
  const [panEnabled, setPanEnabled] = useState(false);

  const pinchRef = useRef(null);
  const panRef = useRef(null);

  const lockedRef = useRef(false);
  const pinchActiveRef = useRef(false);
  const panActiveRef = useRef(false);
  const cooldownRef = useRef(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncLocked = () => {
    const locked = pinchActiveRef.current || panActiveRef.current || cooldownRef.current || curScale.current > 1;
    if (locked !== lockedRef.current) { lockedRef.current = locked; onZoomChange?.(locked); }
  };
  const startCooldown = () => {
    cooldownRef.current = true;
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => { cooldownRef.current = false; cooldownTimer.current = null; syncLocked(); }, COOLDOWN_MS);
  };

  const boundsFor = (s: number) => ({ x: Math.max(0, (width * (s - 1)) / 2), y: Math.max(0, (height * (s - 1)) / 2) });
  const applyBounds = (s: number) => { const b = boundsFor(s); boundsX.setValue(Math.max(1, b.x)); boundsY.setValue(Math.max(1, b.y)); };
  const clampTranslation = () => {
    const b = boundsFor(curScale.current);
    curTX.current = clamp(curTX.current, -b.x, b.x);
    curTY.current = clamp(curTY.current, -b.y, b.y);
    baseTX.setValue(curTX.current);
    baseTY.setValue(curTY.current);
  };

  const settleToFit = () => {
    curScale.current = 1; curTX.current = 0; curTY.current = 0;
    setPanEnabled(false);
    boundsX.setValue(1); boundsY.setValue(1);
    const cfg = { duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true };
    Animated.parallel([
      Animated.timing(baseScale, { toValue: 1, ...cfg }),
      Animated.timing(baseTX, { toValue: 0, ...cfg }),
      Animated.timing(baseTY, { toValue: 0, ...cfg }),
    ]).start();
  };

  const resetInstant = () => {
    curScale.current = 1; curTX.current = 0; curTY.current = 0;
    baseScale.setValue(1); pinchScale.setValue(1);
    baseTX.setValue(0); baseTY.setValue(0); panTX.setValue(0); panTY.setValue(0);
    boundsX.setValue(1); boundsY.setValue(1);
    setPanEnabled(false);
    syncLocked();
  };

  useEffect(() => {
    if (!active) resetInstant();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => () => { if (cooldownTimer.current) clearTimeout(cooldownTimer.current); }, []);

  const onPinchEvent = useRef(
    Animated.event([{ nativeEvent: { scale: pinchScale } }], { useNativeDriver: true }),
  ).current;
  const onPinchState = (e: PinchGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.state === State.ACTIVE) {
      pinchActiveRef.current = true;
      onGesture?.();
      // Interrupt a running settle cleanly, capturing where it was.
      baseScale.stopAnimation((v) => { curScale.current = Math.max(1, v); });
      baseTX.stopAnimation((v) => { curTX.current = v; });
      baseTY.stopAnimation((v) => { curTY.current = v; });
      syncLocked();
    }
    if (e.nativeEvent.oldState === State.ACTIVE) {
      pinchActiveRef.current = false;
      // Bake with no jump: baseScale := raw product, so the curve yields exactly
      // what's on screen; then reset the live gesture value.
      const product = curScale.current * dampGesture(e.nativeEvent.scale);
      baseScale.setValue(Math.max(0, product));
      pinchScale.setValue(1);
      // resetOnRelease never takes the committing branch, so setPanEnabled stays
      // false and the one-finger pan handler is never armed — which is exactly
      // what leaves the feed's own scroll gesture alone.
      if (resetOnRelease || product <= FIT_EPSILON) {
        settleToFit();
      } else {
        const committed = Math.min(MAX_SCALE, product);
        baseScale.setValue(committed);
        curScale.current = committed;
        applyBounds(committed);
        clampTranslation();
        setPanEnabled(true);
      }
      startCooldown();
      syncLocked();
    }
  };

  const onPanEvent = useRef(
    Animated.event([{ nativeEvent: { translationX: panTX, translationY: panTY } }], { useNativeDriver: true }),
  ).current;
  const onPanState = (e: PanGestureHandlerStateChangeEvent) => {
    if (e.nativeEvent.state === State.ACTIVE) { panActiveRef.current = true; onGesture?.(); syncLocked(); }
    if (e.nativeEvent.oldState === State.ACTIVE) {
      panActiveRef.current = false;
      // Commit the finger's end position (clamped). The pan itself is smooth and
      // 1:1; no momentum spring (a spring per release was compounding jank).
      curTX.current += e.nativeEvent.translationX;
      curTY.current += e.nativeEvent.translationY;
      panTX.setValue(0); panTY.setValue(0);
      clampTranslation();
      startCooldown();
      syncLocked();
    }
  };

  return (
    <PanGestureHandler
      ref={panRef}
      enabled={panEnabled}
      minPointers={1}
      maxPointers={1}
      avgTouches
      simultaneousHandlers={pinchRef}
      onGestureEvent={onPanEvent}
      onHandlerStateChange={onPanState}
    >
      <Animated.View style={style}>
        <PinchGestureHandler
          ref={pinchRef}
          simultaneousHandlers={panRef}
          onGestureEvent={onPinchEvent}
          onHandlerStateChange={onPinchState}
        >
          <Animated.View style={[style, { transform: [{ translateX }, { translateY }, { scale }] }]}>
            {children}
          </Animated.View>
        </PinchGestureHandler>
      </Animated.View>
    </PanGestureHandler>
  );
}
