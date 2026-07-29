import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, PanResponder, Dimensions,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '../contexts/LanguageContext';
import {
  TOP_CAPTION_COLORS, TOP_CAPTION_SCALE_MAX, TOP_CAPTION_SCALE_MIN,
  TopCaptionBubble, captionMaxWidth, captionZone, type CaptionZoneKind, type TopCaptionData,
} from './TopCaption';

// Places captions on a video, adapting to its orientation:
//  - HORIZONTAL clips: BOTH letterbox bands in one editor — a true-scale
//    preview of the portrait view (black bands + the clip in the middle),
//    with a placeable zone above the video and one below it. Opening with no
//    captions drops the creator straight into typing the TOP one (the
//    default); the lower dashed box is right there to tap for the second.
//  - VERTICAL clips (fill the screen edge-to-edge): ONE free-placement zone
//    covering the screen between the protected strips (back-button area up
//    top, the reel's meta/rail/scrub area down low).
// Interactions mirror the story sticker layer exactly, per zone:
//   drag  → slide that caption up/down inside its safe zone
//   pinch → resize (raw two-touch distance, re-baselined on finger changes)
//   tap   → type the words / pick bubble colors (tap an empty zone to add;
//           clearing the words removes that zone's caption)
// Ghosts mark what each zone can never cross: the rotate-hint pill above, the
// reel's meta/rail/scrub skeleton below. Everything is stored normalized
// (y 0..1 within the zone, scale multiplier) so the viewer reproduces the
// placement on any screen.

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function defaultCaption(kind: CaptionZoneKind, inherit?: TopCaptionData | null): TopCaptionData {
  return {
    text: '',
    // A second caption inherits the first one's colors so the pair matches.
    bg: inherit?.bg ?? TOP_CAPTION_COLORS[0].bg,
    color: inherit?.color ?? TOP_CAPTION_COLORS[0].color,
    y: kind === 'top' ? 0.35 : kind === 'screen' ? 0.25 : 0.2,
    scale: 1,
  };
}

function pinchDist(touches: Array<{ pageX: number; pageY: number }>): number {
  return Math.hypot(touches[1].pageX - touches[0].pageX, touches[1].pageY - touches[0].pageY);
}

// One band's interactive surface: dashed outline, the caption bubble (or a
// faint + for an empty zone), and the drag/pinch/tap responder.
function ZoneSurface({ kind, aspect, draft, onChange, onOpenText }: {
  kind: CaptionZoneKind;
  aspect: number;
  draft: TopCaptionData | null;
  onChange: (d: TopCaptionData) => void;
  onOpenText: () => void;
}) {
  const [capH, setCapH] = useState(0);
  const capHRef = useRef(0);
  // Refs mirror the gesture-mutated values so the PanResponder (created once)
  // never reads stale state — the StickerLayer pattern.
  const draftRef = useRef(draft); draftRef.current = draft;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onOpenTextRef = useRef(onOpenText); onOpenTextRef.current = onOpenText;

  const base = useRef({ cy: 0, y: 0, dist: 0, scale: 1 });
  const prevCount = useRef(0);
  const moved = useRef(false);

  function rebaseline(touches: Array<{ pageX: number; pageY: number }>) {
    const cy = touches.reduce((s, t2) => s + t2.pageY, 0) / touches.length;
    base.current = {
      cy,
      y: draftRef.current?.y ?? 0,
      dist: touches.length >= 2 ? pinchDist(touches as never) : 0,
      scale: draftRef.current?.scale ?? 1,
    };
    prevCount.current = touches.length;
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      moved.current = false;
      rebaseline(e.nativeEvent.touches as never);
    },
    onPanResponderMove: (e) => {
      const cur = draftRef.current;
      const touches = e.nativeEvent.touches as never as Array<{ pageX: number; pageY: number }>;
      if (!cur || touches.length === 0) return;
      if (touches.length !== prevCount.current) rebaseline(touches); // finger added/removed → no jump
      const cy = touches.reduce((s, t2) => s + t2.pageY, 0) / touches.length;
      const z = captionZone(kind, aspect, SCREEN_W, SCREEN_H);
      const travel = Math.max(1, z.usable - capHRef.current);
      const next = { ...cur };
      const dy = cy - base.current.cy;
      if (Math.abs(dy) > 4) moved.current = true;
      next.y = Math.min(1, Math.max(0, base.current.y + dy / travel));
      if (touches.length >= 2 && base.current.dist > 0) {
        next.scale = Math.max(TOP_CAPTION_SCALE_MIN, Math.min(TOP_CAPTION_SCALE_MAX,
          base.current.scale * (pinchDist(touches as never) / base.current.dist)));
        moved.current = true;
      }
      onChangeRef.current(next);
    },
    onPanResponderRelease: () => {
      // A press with no movement = type in this zone (adds it when empty).
      if (!moved.current) onOpenTextRef.current();
    },
  })).current;

  const zone = captionZone(kind, aspect, SCREEN_W, SCREEN_H);
  if (zone.usable < 34) return null;
  const travel = Math.max(0, zone.usable - capH);
  const capTop = zone.top + (draft?.y ?? 0) * travel;

  return (
    <>
      <View style={[styles.zone, { top: zone.top, height: zone.usable }]} {...pan.panHandlers}>
        <View style={styles.zoneOutline} pointerEvents="none" />
        {!draft?.text.trim() && (
          <View style={styles.zoneEmpty} pointerEvents="none">
            <Ionicons name="add" size={22} color="rgba(255,255,255,0.4)" />
          </View>
        )}
      </View>
      {!!draft?.text.trim() && (
        <View
          pointerEvents="none"
          style={[styles.capWrap, { top: capTop, opacity: capH > 0 ? 1 : 0 }]}
          onLayout={(e) => { setCapH(e.nativeEvent.layout.height); capHRef.current = e.nativeEvent.layout.height; }}
        >
          <TopCaptionBubble data={draft} maxWidth={captionMaxWidth(kind, SCREEN_W)} />
        </View>
      )}
    </>
  );
}

export default function TopCaptionEditor({ visible, aspect, posterUri, initialTop, initialBottom, onSave, onClose }: {
  visible: boolean;
  /** The video's landscape aspect ratio (> 1). */
  aspect: number;
  /** Poster frame for the letterbox preview (cover frame / thumbnail). */
  posterUri: string | null;
  initialTop: TopCaptionData | null;
  initialBottom: TopCaptionData | null;
  /** Both zones at once; null = that zone has no caption. */
  onSave: (top: TopCaptionData | null, bottom: TopCaptionData | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [topDraft, setTopDraft] = useState<TopCaptionData | null>(initialTop);
  const [bottomDraft, setBottomDraft] = useState<TopCaptionData | null>(initialBottom);
  // Which zone the text overlay is editing (null = placement view).
  const [editing, setEditing] = useState<CaptionZoneKind | null>(null);

  // Vertical clips get ONE free-placement zone; the caption stores in the
  // top slot (a video is either landscape or portrait, so the slot's meaning
  // is unambiguous per post).
  const vertical = aspect <= 1;
  const primaryKind: CaptionZoneKind = vertical ? 'screen' : 'top';

  const zone = captionZone('top', aspect, SCREEN_W, SCREEN_H);

  // Re-seed per open; brand-new goes straight to typing the primary caption
  // (the top band for landscape, the screen for vertical).
  useEffect(() => {
    if (!visible) return;
    setTopDraft(initialTop);
    setBottomDraft(initialBottom);
    if (!initialTop && !initialBottom) {
      setTopDraft(defaultCaption(primaryKind));
      setEditing(primaryKind);
    } else {
      setEditing(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const editDraft = editing === 'bottom' ? bottomDraft : editing ? topDraft : null;
  const setEditDraft = (d: TopCaptionData) => (editing === 'bottom' ? setBottomDraft(d) : setTopDraft(d));

  function openText(kind: CaptionZoneKind) {
    if (kind !== 'bottom' && !topDraft) setTopDraft(defaultCaption(kind, bottomDraft));
    if (kind === 'bottom' && !bottomDraft) setBottomDraft(defaultCaption('bottom', topDraft));
    setEditing(kind);
  }

  // Overlay Done: empty words = that zone has no caption.
  function closeText() {
    if (editing && editing !== 'bottom' && !topDraft?.text.trim()) setTopDraft(null);
    if (editing === 'bottom' && !bottomDraft?.text.trim()) setBottomDraft(null);
    setEditing(null);
  }

  function save() {
    const clean = (d: TopCaptionData | null) =>
      d?.text.trim() ? { ...d, text: d.text.trim() } : null;
    onSave(clean(topDraft), clean(bottomDraft));
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {/* True-geometry preview: landscape parks the clip mid-screen between
            its black bands; a vertical clip fills the screen like the reel. */}
        {posterUri ? (
          <ExpoImage
            source={{ uri: posterUri }}
            style={vertical
              ? StyleSheet.absoluteFillObject
              : { position: 'absolute', top: zone.band, left: 0, width: SCREEN_W, height: zone.videoH }}
            contentFit={vertical ? 'cover' : 'contain'}
          />
        ) : (
          <View style={vertical
            ? [styles.videoGhost, StyleSheet.absoluteFillObject]
            : [styles.videoGhost, { top: zone.band, height: zone.videoH }]}>
            <Ionicons name="videocam-outline" size={34} color="rgba(255,255,255,0.35)" />
          </View>
        )}

        {/* Ghosts of the reel UI the captions must never cross: the rotate-hint
            pill up top (landscape only), the meta block + action rail + scrub
            bar down low. */}
        {!vertical && (
          <View style={[styles.hintGhost, { top: zone.band - 52 }]} pointerEvents="none">
            <Ionicons name="phone-landscape-outline" size={15} color="rgba(255,255,255,0.6)" />
            <Text style={styles.hintGhostText}>{t('reel.rotateForFullscreen')}</Text>
          </View>
        )}
        <View style={styles.reelGhost} pointerEvents="none">
          <View style={styles.reelGhostMeta}>
            <View style={[styles.ghostLine, { width: 84, height: 11 }]} />
            <View style={[styles.ghostLine, { width: 190 }]} />
            <View style={[styles.ghostLine, { width: 140 }]} />
          </View>
          <View style={styles.reelGhostRail}>
            {[0, 1, 2, 3].map((i) => <View key={i} style={styles.ghostDot} />)}
          </View>
          <View style={styles.ghostScrub} />
        </View>

        {/* Landscape: both bands, each its own placeable surface.
            Vertical: one free-placement surface over the whole safe area. */}
        {vertical ? (
          <ZoneSurface kind="screen" aspect={aspect} draft={topDraft} onChange={setTopDraft} onOpenText={() => openText('screen')} />
        ) : (
          <>
            <ZoneSurface kind="top" aspect={aspect} draft={topDraft} onChange={setTopDraft} onOpenText={() => openText('top')} />
            <ZoneSurface kind="bottom" aspect={aspect} draft={bottomDraft} onChange={setBottomDraft} onOpenText={() => openText('bottom')} />
          </>
        )}

        {/* Top bar */}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <TouchableOpacity style={styles.barBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity style={styles.saveBtn} onPress={save}>
            <Text style={styles.saveText}>{t('topcap.save')}</Text>
          </TouchableOpacity>
        </View>

        {/* Bottom hint */}
        <Text style={[styles.bottomHint, { bottom: insets.bottom + 16 }]}>{t('topcap.hint')}</Text>

        {/* Text + color editing overlay (per zone) */}
        {editing && editDraft && (
          <KeyboardAvoidingView
            style={StyleSheet.absoluteFill}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.editScrim}>
              <TouchableOpacity style={styles.editDone} onPress={closeText}>
                <Text style={styles.editDoneText}>{t('topcap.save')}</Text>
              </TouchableOpacity>
              <View style={styles.editCenter}>
                <TextInput
                  style={[styles.editInput, {
                    backgroundColor: editDraft.bg,
                    color: editDraft.color,
                    fontSize: Math.round(17 * editDraft.scale),
                  }]}
                  value={editDraft.text}
                  onChangeText={(text) => setEditDraft({ ...editDraft, text })}
                  placeholder={t('topcap.placeholder')}
                  placeholderTextColor={editDraft.color + '77'}
                  multiline
                  autoFocus
                  maxLength={120}
                  textAlign="center"
                />
              </View>
              {/* Bubble color pairs */}
              <View style={styles.swatchRow}>
                {TOP_CAPTION_COLORS.map((c) => {
                  const on = editDraft.bg === c.bg;
                  return (
                    <TouchableOpacity
                      key={c.bg}
                      style={[styles.swatch, { backgroundColor: c.bg }, on && styles.swatchOn]}
                      onPress={() => setEditDraft({ ...editDraft, bg: c.bg, color: c.color })}
                    >
                      <Text style={{ color: c.color, fontSize: 13, fontWeight: '800' }}>A</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </KeyboardAvoidingView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  videoGhost: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: '#101010', alignItems: 'center', justifyContent: 'center',
  },
  hintGhost: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 7, opacity: 0.55,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  hintGhostText: { color: '#fff', fontSize: 12.5, fontWeight: '700', letterSpacing: -0.1 },
  // Faint skeleton of the reel's bottom UI (meta block, action rail, scrub bar)
  // filling the reserved strip below the bottom-caption zone.
  reelGhost: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, opacity: 0.5 },
  reelGhostMeta: { position: 'absolute', left: 16, bottom: 58, gap: 9 },
  ghostLine: { height: 9, width: 160, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.28)' },
  reelGhostRail: { position: 'absolute', right: 14, bottom: 96, gap: 22, alignItems: 'center' },
  ghostDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.22)' },
  ghostScrub: { position: 'absolute', left: 0, right: 0, bottom: 12, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  zone: { position: 'absolute', left: 0, right: 0 },
  zoneOutline: {
    ...StyleSheet.absoluteFillObject, marginHorizontal: 10,
    borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.22)', borderRadius: 12,
  },
  zoneEmpty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  capWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  topBar: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  barBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  saveBtn: {
    backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9,
  },
  saveText: { color: '#111', fontSize: 14, fontWeight: '800' },
  bottomHint: {
    position: 'absolute', left: 24, right: 24, textAlign: 'center',
    color: 'rgba(255,255,255,0.65)', fontSize: 12.5, lineHeight: 18,
  },
  editScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)' },
  editDone: { position: 'absolute', top: 54, right: 16, zIndex: 2, padding: 8 },
  editDoneText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  editCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  editInput: {
    minWidth: 140, maxWidth: '92%', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 8, fontWeight: '800', textAlign: 'center',
  },
  swatchRow: {
    position: 'absolute', bottom: 24, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', gap: 10, flexWrap: 'wrap', paddingHorizontal: 16,
  },
  swatch: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)',
  },
  swatchOn: { borderColor: '#fff', transform: [{ scale: 1.15 }] },
});
