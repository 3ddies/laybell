import { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Dimensions, Image, ActivityIndicator } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import MediaCropper, { type MediaCropperHandle, type CropRect } from './MediaCropper';

// Crop a profile photo behind a CIRCULAR guide.
//
// expo-image-picker's `allowsEditing` hands off to the OS, and on iOS that is a
// SQUARE crop — so people framed a square, and then every surface in the app
// displayed it in a circle and quietly ate the corners. You cannot compose a
// face inside a shape you are not being shown.
//
// The crop itself is still square, and that is correct: an avatar IS a square
// image that gets displayed round. The circle is a guide over the same square
// frame, so what you see kept is what stays visible.
//
// Reuses MediaCropper for the pan/pinch and the source-pixel maths rather than
// reimplementing either.

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME = Math.min(SCREEN_W - SPACING.lg * 2, 340);
// Avatars are shown at 148pt at their largest (onboarding) and far smaller
// everywhere else, so a 1024px square is generous at 3x and keeps the upload
// small. Bigger would cost upload time on a phone network for pixels no surface
// ever asks for.
const OUT_PX = 1024;

export default function AvatarCropModal({
  uri, visible, onCancel, onDone,
}: {
  uri: string | null;
  visible: boolean;
  onCancel: () => void;
  /** Receives a cropped, resized local file uri ready to upload. */
  onDone: (croppedUri: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const cropRef = useRef<MediaCropperHandle>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // MediaCropper needs the source dimensions to compute its cover scale. Reset
  // on every new uri so a second photo cannot be framed against the first one's
  // aspect ratio.
  useEffect(() => {
    setSize(null);
    if (!uri) return;
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => { if (alive) setSize({ w, h }); },
      () => { if (alive) setSize({ w: FRAME, h: FRAME }); },
    );
    return () => { alive = false; };
  }, [uri]);

  async function apply() {
    if (!uri || busy) return;
    setBusy(true);
    try {
      const rect: CropRect | null = cropRef.current?.getCrop() ?? null;
      const actions: ImageManipulator.Action[] = [];
      // No rect means the cropper never measured — publish the image as-is
      // rather than blocking on a crop we cannot compute.
      if (rect && rect.width > 1 && rect.height > 1) actions.push({ crop: rect });
      actions.push({ resize: { width: OUT_PX, height: OUT_PX } });
      const out = await ImageManipulator.manipulateAsync(uri, actions, {
        compress: 0.85,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      onDone(out.uri);
    } catch {
      // Fall back to the original file. A failed crop should cost the framing,
      // never the photo.
      onDone(uri);
    }
    setBusy(false);
  }

  return (
    <Modal visible={visible && !!uri} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onCancel} disabled={busy}>
              <Text style={styles.cancel}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{t('avatarCrop.title')}</Text>
            <TouchableOpacity onPress={apply} disabled={busy || !size}>
              {busy ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.done}>{t('avatarCrop.use')}</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.hint}>{t('avatarCrop.hint')}</Text>

          <View style={styles.stage}>
            {uri && size ? (
              <MediaCropper
                ref={cropRef}
                uri={uri}
                mediaWidth={size.w}
                mediaHeight={size.h}
                frameW={FRAME}
                frameH={FRAME}
                type="image"
                circularMask
              />
            ) : (
              <View style={[styles.stagePlaceholder, { width: FRAME, height: FRAME }]}>
                <ActivityIndicator color={colors.textTertiary} />
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.sm, paddingBottom: SPACING.xxl,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  cancel: { color: colors.textSecondary, fontSize: 15 },
  done: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  hint: {
    color: colors.textTertiary, fontSize: 12.5, textAlign: 'center',
    paddingHorizontal: SPACING.lg, marginBottom: SPACING.md, lineHeight: 17,
  },
  stage: { alignItems: 'center', paddingBottom: SPACING.lg },
  stagePlaceholder: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: RADIUS.md,
  },
});
