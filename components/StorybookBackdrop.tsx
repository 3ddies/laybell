import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import AppVideo from './AppVideo';

// A blurred, cross-fading slideshow of a user's own stories, sitting BEHIND the
// storybook creation sheet. With 3+ stories it rotates them every ROTATE_MS with
// a soft cross-fade. A VIDEO story plays LIVE while it's the active layer (muted,
// looped, behind the blur) — the others sit paused on their poster — so the
// backdrop gently moves instead of being a frozen still. With fewer than 3 it
// falls back to a brand gradient. A dark blur + scrim keep the foreground UI
// readable over anything behind it.
//
// Cost: decorative + editor-only (shown only while an owner with 3+ stories has
// the sheet open) and never more than one video decoding at a time, muted; it's
// an ambient preview, so it passes idleBehavior="pause" (never holds the screen
// awake — see hooks/useIdleAwareLoop).

export type BackdropItem = { url: string; type: 'image' | 'video'; poster?: string | null };

const ROTATE_MS = 3000;
const FADE_MS = 900;
const BRAND = ['#2A1206', '#121016', '#0E0E12'] as const;

export default function StorybookBackdrop({ items }: { items: BackdropItem[] }) {
  // Only usable stories (a real media URL) count toward the slideshow, so a missing or
  // blocked story can never leave a blank layer behind the sheet.
  const its = (items ?? []).filter((i) => i && typeof i.url === 'string' && i.url.length > 0).slice(0, 3);
  // Three distinct stories are needed for the cross-fade to read as a slideshow. With
  // fewer — or when the media simply can't load — we DOWNGRADE to the brand gradient +
  // scrim below (always rendered), which keeps the sheet perfectly legible on its own.
  const enough = its.length >= 3;
  const [index, setIndex] = useState(0);

  // Exactly three, created once, so they survive the async arrival of `items`
  // (the editor fetches stories after mount).
  const o0 = useRef(new Animated.Value(1)).current;
  const o1 = useRef(new Animated.Value(0)).current;
  const o2 = useRef(new Animated.Value(0)).current;
  const opac = [o0, o1, o2];

  useEffect(() => {
    if (!enough) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % its.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [enough, its.length]);

  useEffect(() => {
    if (!enough) return;
    Animated.parallel(opac.map((v, i) =>
      Animated.timing(v, { toValue: i === index ? 1 : 0, duration: FADE_MS, useNativeDriver: true }),
    )).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, enough]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Brand gradient — the base, and the whole backdrop when there aren't 3 stories */}
      <LinearGradient colors={BRAND} style={StyleSheet.absoluteFill} />
      {enough && its.map((it, i) => (
        <Animated.View key={`${i}-${it.url}`} style={[StyleSheet.absoluteFill, { opacity: opac[i] }]}>
          {it.type === 'video' ? (
            <AppVideo
              source={{ uri: it.url }}
              style={StyleSheet.absoluteFill as any}
              contentFit="cover"
              active={i === index}        // only the on-screen layer decodes/plays
              loop
              muted                        // decorative — never audible
              poster={it.poster ?? undefined}
              idleBehavior="pause"         // ambient preview: never holds the screen awake
            />
          ) : (
            <Image source={{ uri: it.url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
          )}
        </Animated.View>
      ))}
      {/* Blur the composite only when there's real imagery to blur; the gradient-only
          fallback skips it (nothing to blur, and it avoids any BlurView cost/quirk there).
          Even if BlurView renders nothing on a given device, the scrim below still carries
          legibility, so the sheet is never unreadable. */}
      {enough ? <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} /> : null}
      <LinearGradient
        colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.72)'] as const}
        locations={[0, 0.45, 1] as const}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
