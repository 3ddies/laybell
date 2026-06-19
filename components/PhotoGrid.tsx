import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const NUM_COLS = 4;
const GAP = 2;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS - 1)) / NUM_COLS;
const PAGE = 60;

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

// Device camera-roll grid (Instagram-style) showing photos AND videos together.
// Thumbnails render the asset's ph:// URI via expo-image (fast, poster frames for
// videos); the chosen asset is resolved to a file:// path only on tap. Selected
// items show a check (single) or an order number (slideshow), and tapping a
// selected item removes it (onRemove).
export default function PhotoGrid({ onPick, onRemove, onScroll, onScrollActive, selectedIds = [], numbered = false }: {
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
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (after?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
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
        return merged;
      });
      setEndCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch {
      // ignore — empty state will show
    }
    loadingRef.current = false;
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let p = permission;
      if (!p || !p.granted) p = await requestPermission();
      if (cancelled || !p?.granted) return;
      setAssets([]); setEndCursor(undefined); setHasNext(true);
      loadPage(undefined);
    })();
    return () => { cancelled = true; };
  }, []);

  async function selectAsset(asset: MediaLibrary.Asset) {
    if (resolvingId) return;
    setResolvingId(asset.id);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri || asset.uri;
      const type: 'image' | 'video' = asset.mediaType === MediaLibrary.MediaType.video ? 'video' : 'image';
      // Video posters render reliably from the ph:// asset via expo-image.
      const posterUri = type === 'video' ? asset.uri : uri;
      onPick({ id: asset.id, uri, posterUri, width: asset.width, height: asset.height, duration: asset.duration, type });
    } catch {
      // ignore — user can tap another
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
        <Text style={styles.permText}>Allow photo access to pick from your library</Text>
        <TouchableOpacity style={styles.permBtn} onPress={() => requestPermission()}>
          <Text style={styles.permBtnText}>Grant access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const data: any[] = [{ id: '__camera__' }, ...assets];

  return (
    <FlatList
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
}

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
