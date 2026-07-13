import { useEffect, useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, ActivityIndicator, Platform,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { resolveAssetUri, evictAssetUri } from '../lib/assetInfoCache';

const NUM_COLS = 4;
const GAP = 2;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS - 1)) / NUM_COLS;
const ROW_H = CELL + GAP; // fixed row geometry (contentContainer gap) → getItemLayout
const PAGE = 60;

// Session cache of loaded pages, keyed by grid flavor. The grid UNMOUNTS every
// time the composer advances to the details step (and on the audio sub-tab), so
// without this every return to the picker re-ran the permission round-trip + a
// fresh 60-asset fetch + re-decoded every thumbnail — the "grid takes a beat to
// appear" feel. Remounts now paint instantly from cache while page 1 refreshes
// underneath (new photos taken since the last visit appear at the top).
type GridCache = { assets: MediaLibrary.Asset[]; endCursor?: string; hasNext: boolean };
const gridCache = new Map<string, GridCache>();

export type PickedMedia = {
  id: string;             // MediaLibrary asset id (or the uri for a fresh camera capture)
  uri: string;            // file:// — for cropping/upload
  posterUri?: string;     // ph:// (video) shown as a still preview via expo-image
  width: number;
  height: number;
  duration?: number;      // seconds (video)
  type: 'image' | 'video';
};

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Imperative handle: lets the host scroll the grid back to the top (e.g. after a
// pick, so the collapsing preview re-expands and shows the chosen media).
export type PhotoGridHandle = { scrollToTop: () => void };

type PhotoGridProps = {
  onPick: (m: PickedMedia) => void;
  onRemove?: (id: string) => void;
  onScroll?: (e: any) => void;
  // Fires true when the grid starts being dragged and false when scrolling settles —
  // lets the host suppress the tab swipe only during an active scroll (reliably).
  onScrollActive?: (active: boolean) => void;
  // Asset ids currently selected (single → one; slideshow → ordered).
  selectedIds?: string[];
  // Show the selection order (slideshow) instead of a plain check (single).
  numbered?: boolean;
  // Videos only (e.g. the ad manager's video creative picker) — also hides the
  // camera tile, which captures stills.
  videosOnly?: boolean;
};

// Device camera-roll grid (Instagram-style) showing photos AND videos together.
// Thumbnails render the asset's ph:// URI via expo-image (fast, poster frames for
// videos); the chosen asset is resolved to a file:// path only on tap. Selected
// items show a check (single) or an order number (slideshow), and tapping a
// selected item removes it (onRemove).
const PhotoGrid = forwardRef<PhotoGridHandle, PhotoGridProps>(function PhotoGrid(
  { onPick, onRemove, onScroll, onScrollActive, selectedIds = [], numbered = false, videosOnly = false },
  ref,
) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const cacheKey = videosOnly ? 'videos' : 'all';
  const cached = gridCache.get(cacheKey);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>(cached?.assets ?? []);
  const [endCursor, setEndCursor] = useState<string | undefined>(cached?.endCursor);
  const [hasNext, setHasNext] = useState(cached?.hasNext ?? true);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);

  useImperativeHandle(ref, () => ({
    scrollToTop: () => flatListRef.current?.scrollToOffset({ offset: 0, animated: true }),
  }), []);

  const loadPage = useCallback(async (after?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: videosOnly
          ? [MediaLibrary.MediaType.video]
          : [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        first: PAGE,
        after,
      });
      // Dedupe by asset id: expo-media-library can return the SAME asset across
      // pages (iCloud / edited / shared photos), which would give the numColumns
      // FlatList two cells with the same key → a React "two children with the same
      // key" warning. Drop anything already in the list (and intra-page repeats).
      setAssets(prev => {
        const base = after ? prev : [];
        const seen = new Set(base.map(a => a.id));
        const merged = base.slice();
        for (const a of page.assets) {
          if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
        }
        // Keep the session cache in lockstep so the next remount paints instantly.
        gridCache.set(cacheKey, { assets: merged, endCursor: page.endCursor, hasNext: page.hasNextPage });
        return merged;
      });
      setEndCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch {
      // ignore — empty state will show
    }
    loadingRef.current = false;
    setLoading(false);
  }, [videosOnly, cacheKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let p = permission;
      if (!p || !p.granted) p = await requestPermission();
      if (cancelled || !p?.granted) return;
      // Cached remount: keep painting the cached grid (list is at the top on a
      // fresh mount, so the refresh below can safely replace it) — only a truly
      // cold start wipes to empty first.
      if (!gridCache.has(cacheKey)) { setAssets([]); setEndCursor(undefined); setHasNext(true); }
      loadPage(undefined);
    })();
    return () => { cancelled = true; };
  }, []);

  async function selectAsset(asset: MediaLibrary.Asset) {
    if (resolvingId) return;
    setResolvingId(asset.id);
    try {
      // Cached across the session (lib/assetInfoCache): re-picking the same
      // asset — very common while composing slideshows — is now instant, and
      // the iCloud download only ever happens once per asset.
      const uri = await resolveAssetUri(asset);
      const type: 'image' | 'video' = asset.mediaType === MediaLibrary.MediaType.video ? 'video' : 'image';
      // Video posters render reliably from the ph:// asset via expo-image.
      const posterUri = type === 'video' ? asset.uri : uri;
      onPick({ id: asset.id, uri, posterUri, width: asset.width, height: asset.height, duration: asset.duration, type });
    } catch {
      // A cached localUri can go stale if the asset was edited/deleted —
      // evict so the next tap resolves fresh.
      evictAssetUri(asset.id);
    } finally {
      setResolvingId(null);
    }
  }

  async function openCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      // No MediaLibrary id for a fresh capture — key it by its uri.
      onPick({ id: a.uri, uri: a.uri, posterUri: a.uri, width: a.width ?? 1, height: a.height ?? 1, type: 'image' });
    }
  }

  if (permission && !permission.granted) {
    return (
      <View style={styles.center}>
        <Ionicons name="images-outline" size={36} color={colors.textTertiary} />
        <Text style={styles.permText}>{t('photoGrid.permText')}</Text>
        <TouchableOpacity style={styles.permBtn} onPress={() => requestPermission()}>
          <Text style={styles.permBtnText}>{t('photoGrid.grantAccess')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const data: any[] = videosOnly ? [...assets] : [{ id: '__camera__' }, ...assets];

  return (
    <FlatList
      ref={flatListRef}
      data={data}
      keyExtractor={(item) => item.id}
      numColumns={NUM_COLS}
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={{ gap: GAP }}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => onScrollActive?.(true)}
      onScrollEndDrag={() => onScrollActive?.(false)}
      onMomentumScrollEnd={() => onScrollActive?.(false)}
      onEndReached={() => { if (hasNext && endCursor && !loadingRef.current) loadPage(endCursor); }}
      onEndReachedThreshold={0.6}
      // Fixed-geometry virtualization: paint a full screen of cells in the first
      // pass (default was 10 items ≈ 2.5 rows back-filling batch by batch) and
      // skip async layout measurement entirely.
      getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * Math.floor(index / NUM_COLS), index })}
      initialNumToRender={NUM_COLS * 8}
      maxToRenderPerBatch={NUM_COLS * 4}
      windowSize={7}
      removeClippedSubviews={Platform.OS === 'android'}
      ListFooterComponent={loading ? <ActivityIndicator color={colors.primary} style={{ margin: SPACING.md }} /> : null}
      renderItem={({ item }) => {
        if (item.id === '__camera__') {
          return (
            <TouchableOpacity style={[styles.cell, styles.cameraCell]} onPress={openCamera}>
              <Ionicons name="camera" size={26} color={colors.text} />
            </TouchableOpacity>
          );
        }
        const selIndex = selectedIds.indexOf(item.id);
        const selected = selIndex >= 0;
        const isVideo = item.mediaType === MediaLibrary.MediaType.video;
        return (
          <TouchableOpacity
            style={styles.cell}
            activeOpacity={0.85}
            onPress={() => (selected ? onRemove?.(item.id) : selectAsset(item))}
          >
            <ExpoImage
              source={{ uri: item.uri }}
              style={styles.thumb}
              contentFit="cover"
              recyclingKey={item.id}
              cachePolicy="memory-disk"
              transition={120}
            />
            {isVideo && item.duration > 0 && (
              <Text style={styles.dur}>{formatDur(item.duration)}</Text>
            )}
            {selected && <View style={styles.selOverlay} pointerEvents="none" />}
            {selected && (
              <View style={styles.selBadge}>
                {numbered
                  ? <Text style={styles.selBadgeText}>{selIndex + 1}</Text>
                  : <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
            )}
            {resolvingId === item.id && (
              <View style={styles.resolving}><ActivityIndicator color={colors.text} /></View>
            )}
          </TouchableOpacity>
        );
      }}
    />
  );
});

export default PhotoGrid;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  cell: { width: CELL, height: CELL, backgroundColor: colors.surfaceLight },
  cameraCell: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  thumb: { width: '100%', height: '100%' },
  dur: {
    position: 'absolute', bottom: 4, right: 4, color: '#fff', fontSize: 11, fontWeight: '700',
    textShadowColor: '#000', textShadowRadius: 3,
  },
  selOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 2, borderColor: colors.primary },
  selBadge: {
    position: 'absolute', top: 4, right: 4, minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  selBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  resolving: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg, gap: SPACING.md },
  permText: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  permBtn: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg },
  permBtnText: { color: colors.text, fontWeight: '700' },
});
