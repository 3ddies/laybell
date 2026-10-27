import { ReactNode, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing, type StyleProp, type ViewStyle, type GestureResponderEvent } from 'react-native';
import { supabase } from '../lib/supabase';
import { SPACING } from '../constants/theme';
import { tg } from '../lib/i18n';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// "View Post" tag geometry (Instagram-style label + caret). Estimates are used only for the first
// frame before onLayout measures the real pill; the pop-in fade hides that one-frame settle.
const CARET_W = 8;   // half-base of the caret triangle
const CARET_H = 9;   // caret height
const TAG_EST_W = 138;
const TAG_EST_H = 46;
const TAG_PAD = 6;   // keep the whole tag at least this far inside the card

// THE single source of truth for how a post reshared to a story looks: the rounded media card plus
// the author handle BELOW it (plain bold white text, left-aligned — no on-card pill). Used by BOTH
// the post-to-story EDITOR (where the whole unit is the draggable sticker) and the story VIEWER
// (where it's placed from the saved layout and tapping it opens the original post). One component so
// the editor and the published story can never drift — the editor is the canonical look.
//
// Geometry: the root is a left-aligned column [card, @handle]. Callers center it in the frame and
// (viewer) apply the saved position transform via `style`, so the card+handle unit is centered as a
// whole exactly like the editor's draggable sticker — the handle's height is part of the unit, so the
// card sits identically in both.

// Author handle resolved by post id (viewer has only the id). Cached per id so every story is cheap.
const nameCache = new Map<string, string | null>();

function useResolvedUsername(username: string | null | undefined, postId: string | undefined): string | null {
  const known = username != null ? username : (postId && nameCache.has(postId) ? nameCache.get(postId)! : null);
  const [name, setName] = useState<string | null>(known);
  useEffect(() => {
    if (username != null) { setName(username); return; }
    if (!postId) return;
    if (nameCache.has(postId)) { setName(nameCache.get(postId)!); return; }
    let alive = true;
    supabase
      .from('posts')
      .select('profiles!posts_user_id_fkey(username)')
      .eq('id', postId)
      .single()
      .then(({ data }) => {
        const d = data as any;
        const prof = d ? (Array.isArray(d.profiles) ? d.profiles[0] : d.profiles) : null;
        const u = (prof?.username ?? null) as string | null;
        nameCache.set(postId, u);
        if (alive) setName(u);
      }, () => {});
    return () => { alive = false; };
  }, [username, postId]);
  return name;
}

export default function RepostCard({
  cardW, cardH, username, postId, children, onPress, revealed, onViewPost, style,
}: {
  cardW: number;
  cardH: number;
  username?: string | null;     // supply when the caller already has it (editor); else resolved from postId
  postId?: string;              // viewer: resolve the handle by post id (cached)
  children: ReactNode;          // the media (RepostPostMedia)
  onPress?: () => void;         // viewer: tap the card → reveal / dismiss the "View Post" button. Editor omits it (draggable).
  revealed?: boolean;           // viewer: show the "View Post" button on the card (Instagram two-step)
  onViewPost?: () => void;      // viewer: tap the button → open the original post
  style?: StyleProp<ViewStyle>; // viewer applies the saved position transform here
}) {
  const name = useResolvedUsername(username, postId);
  // Where on the card the user last tapped (card-local pixels) — the "View Post" tag springs up from
  // exactly there, like an Instagram tag, instead of being centered.
  const [tap, setTap] = useState<{ x: number; y: number } | null>(null);
  const [tagSize, setTagSize] = useState<{ w: number; h: number } | null>(null);
  const pop = useRef(new Animated.Value(0)).current;   // entrance (opacity + scale + slide)
  const bump = useRef(new Animated.Value(1)).current;  // per-move scale pop (opacity stays solid)
  const shownRef = useRef(false);

  const handleCardPress = (e: GestureResponderEvent) => {
    const ne = e?.nativeEvent;
    if (ne && typeof ne.locationX === 'number' && typeof ne.locationY === 'number') {
      setTap({ x: ne.locationX, y: ne.locationY });
    }
    onPress?.();
  };

  // First reveal → the entrance (fade + subtle scale + slide), a quick ease-out, no bounce. Each
  // CONSECUTIVE tap moves the tag to the new spot and fires a quick scale "pop" (bump) — opacity
  // stays solid so it doesn't blink, it just snaps in satisfyingly at the new point.
  useEffect(() => {
    if (!revealed) { shownRef.current = false; return; }
    if (!shownRef.current) {
      shownRef.current = true;
      bump.setValue(1);
      pop.setValue(0);
      Animated.timing(pop, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      bump.setValue(0);
      Animated.timing(bump, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [revealed, tap, pop, bump]);

  // Place the tag: caret tip pinned at the tap point, label hanging below — or flipped above when the
  // tap is near the bottom — and clamped so the whole tag stays inside the card.
  const tp = tap ?? { x: cardW / 2, y: cardH / 2 };
  const tw = tagSize?.w ?? TAG_EST_W;
  const th = tagSize?.h ?? TAG_EST_H;
  const below = tp.y + th <= cardH - TAG_PAD;
  const tagLeft = clamp(tp.x - tw / 2, TAG_PAD, Math.max(TAG_PAD, cardW - tw - TAG_PAD));
  const tagTop = below ? tp.y : Math.max(TAG_PAD, tp.y - th);
  // When the label is clamped near an edge, nudge the caret so it still points at the tap x.
  const caretBound = Math.max(0, tw / 2 - CARET_W - 4);
  const caretDx = clamp(tp.x - tagLeft - tw / 2, -caretBound, caretBound);
  const popStyle = {
    opacity: pop,
    transform: [
      { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
      { scale: bump.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
      { translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [below ? -4 : 4, 0] }) },
    ],
  };

  // The card + (when revealed) the "View Post" tag at the tap point. The media is pointer-transparent
  // and the tag's label sits in a box-none layer, so a tap on the label opens the post while a tap
  // anywhere else on the card bubbles to the outer Pressable (reveal/dismiss). The editor passes no
  // onPress/onViewPost, so none of this is interactive there.
  const card = (
    <View style={[styles.card, { width: cardW, height: cardH }]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">{children}</View>
      {revealed && onViewPost ? (
        <Animated.View
          pointerEvents="box-none"
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (!tagSize || Math.abs(tagSize.w - width) > 0.5 || Math.abs(tagSize.h - height) > 0.5) {
              setTagSize({ w: width, h: height });
            }
          }}
          style={[styles.tag, { left: tagLeft, top: tagTop }, popStyle]}
        >
          {below ? <View style={[styles.caretUp, { transform: [{ translateX: caretDx }] }]} pointerEvents="none" /> : null}
          <Pressable style={styles.tagLabel} onPress={onViewPost} accessibilityRole="button" hitSlop={10}>
            <Text style={styles.tagText}>{tg('story.viewPost')}</Text>
          </Pressable>
          {below ? null : <View style={[styles.caretDown, { transform: [{ translateX: caretDx }] }]} pointerEvents="none" />}
        </Animated.View>
      ) : null}
    </View>
  );
  return (
    <View style={[styles.wrap, style]}>
      {onPress ? (
        <Pressable onPress={handleCardPress} accessibilityRole="button">{card}</Pressable>
      ) : card}
      <Text style={[styles.name, { maxWidth: cardW }]} numberOfLines={1} pointerEvents="none">@{name ?? 'laybell'}</Text>
    </View>
  );
}

// Grey tag with white text. SOLID (opaque) so the label and its caret are the exact same shade with
// no translucency seam where they overlap; the caret reuses this color and NEITHER carries a shadow,
// so the arrow and the label read as one flat piece at the same depth.
const TAG_BG = 'rgb(70,70,74)';
const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-start' },
  card: {
    borderRadius: 10, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  // Instagram-style tag: a grey rounded label with a small caret (same colour) pointing at the tap.
  tag: { position: 'absolute', alignItems: 'center' },
  tagLabel: {
    paddingVertical: 8, paddingHorizontal: 16, borderRadius: 11, backgroundColor: TAG_BG,
  },
  tagText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  caretUp: {
    width: 0, height: 0, marginBottom: -1,
    borderLeftWidth: CARET_W, borderRightWidth: CARET_W, borderBottomWidth: CARET_H,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: TAG_BG,
  },
  caretDown: {
    width: 0, height: 0, marginTop: -1,
    borderLeftWidth: CARET_W, borderRightWidth: CARET_W, borderTopWidth: CARET_H,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: TAG_BG,
  },
  // Author handle below the card: plain bold white text, no avatar/pill, with a soft shadow so it
  // stays legible over a light background.
  name: {
    color: '#fff', fontSize: 16, fontWeight: '700', marginTop: SPACING.xs, marginLeft: 2,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
});
