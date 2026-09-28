import { memo, useRef, useState } from 'react';
import {
  Dimensions, KeyboardAvoidingView, Platform, Pressable, PanResponder,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import MentionSuggestions from './MentionSuggestions';
import { getActiveMentionQuery, applyMention } from '../lib/mentions';
import { resolveSticker, STICKER_COLORS, STICKER_FONTS, type StickerBg, type StickerFont } from './StickerLayer';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The full-screen text-sticker editor for the Post-to-story screen: a live-styled
// preview + font/colour/background toolbar + a vertical size slider, committing its
// working values back in one go. This is a self-contained sibling of the identical
// editor inside app/(tabs)/story-camera.tsx — kept separate on purpose so building
// the repost editor never risks the live story camera; the two can be unified later
// with a device-testing pass.

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const SLIDER_H = 220;
const SIZE_MIN = 14;
const SIZE_MAX = 56;

function sizeFromTrackY(y: number) {
  const clamped = Math.max(0, Math.min(SLIDER_H, y));
  return Math.round(SIZE_MAX - (clamped / SLIDER_H) * (SIZE_MAX - SIZE_MIN));
}

function resolveStickerFontPreview(font: StickerFont) {
  switch (font) {
    case 'bold': return { fontWeight: '900' as const };
    case 'typewriter': return { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' };
    case 'serif': return { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' };
    case 'neon': return { textShadowColor: '#fff', textShadowRadius: 8 };
    default: return { fontWeight: '700' as const };
  }
}

const RepostTextEditor = memo(function RepostTextEditor({
  initialText, initialFont, initialColor, initialBg, initialSize, onCommit,
}: {
  initialText: string;
  initialFont: StickerFont;
  initialColor: string;
  initialBg: StickerBg;
  initialSize: number;
  onCommit: (vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [text, setText] = useState(initialText);
  const [font, setFont] = useState<StickerFont>(initialFont);
  const [color, setColor] = useState(initialColor);
  const [bg, setBg] = useState<StickerBg>(initialBg);
  const [size, setSize] = useState(initialSize);
  const [textH, setTextH] = useState(0);

  const sizeSliderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
      onPanResponderMove: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
    }),
  ).current;

  const preview = resolveSticker({ font, color, bg, size });
  const sliderKnobTop = ((SIZE_MAX - size) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 11;
  const finish = () => onCommit({ text, font, color, bg, size });

  return (
    <KeyboardAvoidingView
      style={[StyleSheet.absoluteFill, styles.stickerEditor]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={finish} />
      <View style={[styles.stickerDoneRow, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.stickerDoneBtn} onPress={finish} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.stickerDoneText}>{t('storyCamera.done')}</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.sizeSlider, { top: SCREEN_H * 0.24 }]} {...sizeSliderPan.panHandlers}>
        <View style={styles.sizeTrack} />
        <View style={[styles.sizeKnob, { top: Math.max(0, Math.min(SLIDER_H - 22, sliderKnobTop)) }]} pointerEvents="none" />
      </View>
      <View style={styles.stickerInputWrap} pointerEvents="box-none">
        <View style={[preview.boxStyle, styles.editorBox]}>
          <TextInput
            style={[styles.stickerInput, preview.textStyle, {
              height: (textH > 0 ? textH : ((preview.textStyle.lineHeight as number) ?? 34)) + 8,
              maxHeight: SCREEN_H * 0.45,
            }]}
            value={text}
            onChangeText={setText}
            placeholder={t('storyCamera.typeSomething')}
            placeholderTextColor="rgba(255,255,255,0.55)"
            selectionColor="#FAB525"
            cursorColor="#FAB525"
            multiline
            scrollEnabled={false}
            autoFocus
            maxLength={200}
            textAlign="center"
          />
          <Text
            style={[styles.stickerInput, preview.textStyle, styles.measureGhost]}
            onLayout={(e) => {
              const h = Math.ceil(e.nativeEvent.layout.height);
              setTextH((prev) => (prev === h ? prev : h));
            }}
          >
            {text.length === 0 ? ' ' : text.endsWith('\n') ? `${text} ` : text}
          </Text>
        </View>
        <MentionSuggestions
          query={getActiveMentionQuery(text, text.length)}
          onPick={(u) => setText(applyMention(text, text.length, u).text)}
          style={{ marginTop: SPACING.md, alignSelf: 'center', minWidth: 240 }}
          maxHeight={160}
        />
      </View>

      <View style={styles.styleBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow} keyboardShouldPersistTaps="always">
          {STICKER_COLORS.map((c) => (
            <TouchableOpacity key={c} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]} onPress={() => setColor(c)} />
          ))}
        </ScrollView>
        <View style={styles.fontRow}>
          <TouchableOpacity
            style={[styles.bgToggle, bg !== 'none' && styles.bgToggleActive]}
            onPress={() => setBg((b) => (b === 'none' ? 'soft' : b === 'soft' ? 'pill' : b === 'pill' ? 'boxy' : 'none'))}
          >
            <Ionicons name="color-fill-outline" size={18} color="#fff" />
          </TouchableOpacity>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
            {STICKER_FONTS.map((f) => (
              <TouchableOpacity key={f.key} style={[styles.fontPill, font === f.key && styles.fontPillActive]} onPress={() => setFont(f.key)}>
                <Text style={[styles.fontPillText, resolveStickerFontPreview(f.key)]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
});

export default RepostTextEditor;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  stickerEditor: { backgroundColor: 'rgba(0,0,0,0.55)' },
  stickerDoneRow: { position: 'absolute', right: SPACING.md, flexDirection: 'row', justifyContent: 'flex-end', zIndex: 2 },
  stickerDoneBtn: { backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.md, paddingVertical: 7 },
  stickerDoneText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sizeSlider: { position: 'absolute', left: 4, width: 44, height: SLIDER_H, alignItems: 'center', zIndex: 2 },
  sizeTrack: { width: 4, height: '100%', borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  sizeKnob: {
    position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 4,
  },
  stickerInputWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  stickerInput: { width: 300, paddingVertical: 0, paddingHorizontal: 0, textAlignVertical: 'center' },
  editorBox: { alignSelf: 'center' },
  measureGhost: { position: 'absolute', opacity: 0, width: 286, left: 7 },
  styleBar: { paddingBottom: SPACING.sm, gap: SPACING.sm },
  swatchRow: { paddingHorizontal: SPACING.md, paddingVertical: 6, gap: SPACING.sm, alignItems: 'center' },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, gap: SPACING.sm },
  bgToggle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.15)' },
  bgToggleActive: { backgroundColor: colors.primary },
  fontPills: { gap: SPACING.sm, alignItems: 'center' },
  fontPill: { paddingHorizontal: SPACING.md, paddingVertical: 7, borderRadius: RADIUS.full, backgroundColor: 'rgba(255,255,255,0.15)' },
  fontPillActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  fontPillText: { color: '#fff', fontSize: 13 },
});
