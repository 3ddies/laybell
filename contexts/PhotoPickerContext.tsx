import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Modal, Platform, useWindowDimensions,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { uploadToStorageWithProgress } from '../lib/upload';
import { resolveAssetUri, evictAssetUri } from '../lib/assetInfoCache';
import { setPhotoPickerHandler, type PhotoPickRequest } from '../lib/photoPicker';
import type { Attachment } from '../lib/attachments';

// In-app photo grid for comment image attachments. Rendered in its own
// FullWindowOverlay (iOS) so it appears ABOVE the Now Playing player — the native
// OS picker presents behind that overlay window and is unreachable there. Picks
// from the device library via expo-media-library, converts to JPEG for
// cross-platform viewability (GIFs kept as-is), uploads, and hands back an
// Attachment. See lib/photoPicker.
const PAGE = 60;

export function PhotoPickerProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - SPACING.md * 2 - SPACING.xs * 2) / 3);

  const [req, setReq] = useState<PhotoPickRequest | null>(null);
  const [perm, setPerm] = useState<boolean | null>(null);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  useEffect(() => {
    setPhotoPickerHandler(setReq);
    return () => setPhotoPickerHandler(null);
  }, []);

  const loadPage = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const res = await MediaLibrary.getAssetsAsync({
        first: PAGE,
        after,
        mediaType: [MediaLibrary.MediaType.photo],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      setAssets((prev) => (after ? [...prev, ...res.assets] : res.assets));
      setCursor(res.endCursor);
      setHasNext(res.hasNextPage);
    } catch { /* leave what we have */ }
    setLoading(false);
  }, []);

  // On open: ensure permission, then load the first page. Assets from a prior
  // open are deliberately KEPT (the provider is app-level, so they persist in
  // state) — the grid paints instantly on reopen while loadPage() refreshes
  // page 1 underneath. Previously every open cold-started behind a full-screen
  // spinner: permission IPC → full 60-asset fetch → only then any pixels.
  useEffect(() => {
    if (!req) return;
    let active = true;
    (async () => {
      const cur = await MediaLibrary.getPermissionsAsync();
      let granted = cur.granted;
      if (!granted && cur.canAskAgain) granted = (await MediaLibrary.requestPermissionsAsync()).granted;
      if (!active) return;
      setPerm(granted);
      if (granted) loadPage(); // no-cursor load REPLACES page 1 — fresh photos appear at the top
    })();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  function close() {
    // Keep assets/cursor/hasNext — the next open reuses them (see above).
    setReq(null);
    setUploadingId(null);
  }

  async function pick(asset: MediaLibrary.Asset) {
    if (uploadingId || !req) return;
    setUploadingId(asset.id);
    try {
      // Session-cached (lib/assetInfoCache) — re-picking skips the slow
      // getAssetInfoAsync round-trip / iCloud download.
      const localUri = await resolveAssetUri(asset);
      const isGif = (asset.filename ?? '').toLowerCase().endsWith('.gif');
      let uploadUri = localUri;
      let ext = 'jpg';
      let mime = 'image/jpeg';
      if (isGif) {
        ext = 'gif'; mime = 'image/gif';
      } else {
        // Re-encode to JPEG so HEIC/HEIF (iOS default) is viewable everywhere.
        const out = await ImageManipulator.manipulateAsync(localUri, [], { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG });
        uploadUri = out.uri;
      }
      const url = await uploadToStorageWithProgress('posts', req.userId, uploadUri, ext, mime);
      const att: Attachment = { type: isGif ? 'gif' : 'image', url, w: asset.width, h: asset.height };
      req.onPicked(att);
      close();
    } catch {
      evictAssetUri(asset.id); // stale cached localUri (asset edited/deleted) — next tap resolves fresh
      setUploadingId(null);
    }
  }

  const content = (
    <View style={[styles.container, { paddingTop: insets.top + SPACING.sm }]}>
      <View style={styles.topRow}>
        <Text style={styles.title}>{t('photoPicker.title')}</Text>
        <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} disabled={!!uploadingId}>
          <Text style={[styles.cancel, !!uploadingId && { opacity: 0.4 }]}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>

      {perm === false ? (
        <View style={styles.center}>
          <Ionicons name="images-outline" size={36} color={colors.textTertiary} />
          <Text style={styles.hintTitle}>{t('photoPicker.permTitle')}</Text>
          <Text style={styles.hintBody}>{t('photoPicker.permBody')}</Text>
        </View>
      ) : (perm === null || loading) && assets.length === 0 ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={assets}
          keyExtractor={(a) => a.id}
          numColumns={3}
          columnWrapperStyle={styles.col}
          contentContainerStyle={styles.grid}
          // Fixed-geometry virtualization: paint a full screen of thumbnails in
          // the first pass instead of back-filling 10 items at a time.
          getItemLayout={(_, i) => ({ length: cell + SPACING.xs, offset: (cell + SPACING.xs) * Math.floor(i / 3), index: i })}
          initialNumToRender={24}
          maxToRenderPerBatch={12}
          windowSize={7}
          onEndReachedThreshold={0.6}
          onEndReached={() => { if (hasNext && !loading) loadPage(cursor); }}
          ListEmptyComponent={!loading ? <View style={styles.center}><Text style={styles.hintBody}>{t('photoPicker.empty')}</Text></View> : null}
          ListFooterComponent={loading && assets.length > 0 ? <ActivityIndicator color={colors.primary} style={{ paddingVertical: SPACING.md }} /> : null}
          renderItem={({ item }) => (
            <TouchableOpacity activeOpacity={0.8} onPress={() => pick(item)} disabled={!!uploadingId}>
              <Image source={{ uri: item.uri }} style={{ width: cell, height: cell, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight }} contentFit="cover" recyclingKey={item.id} cachePolicy="memory-disk" />
              {uploadingId === item.id && (
                <View style={[StyleSheet.absoluteFill, styles.uploading]}>
                  <ActivityIndicator color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );

  // iOS: render in its own FullWindowOverlay so it sits above the Now Playing
  // overlay; Android uses a Modal.
  const layer = Platform.OS === 'ios'
    ? (req ? <FullWindowOverlay>{content}</FullWindowOverlay> : null)
    : <Modal visible={!!req} animationType="slide" onRequestClose={close}>{content}</Modal>;

  return (
    <>
      {children}
      {layer}
    </>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  cancel: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  col: { gap: SPACING.xs, paddingHorizontal: SPACING.md },
  grid: { gap: SPACING.xs, paddingBottom: SPACING.xl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  hintTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  hintBody: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
  uploading: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.sm },
});
