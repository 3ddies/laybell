import { useEffect, useState, useCallback, useMemo, useRef, memo, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, ActivityIndicator,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
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
const HALF_GAP = GAP / 2;           // per-cell inset → GAP between neighbours, HALF_GAP at edges
const SCREEN_W = Dimensions.get('window').width;
const COL_W = SCREEN_W / NUM_COLS;  // one square slot; the thumb sits inside it inset by HALF_GAP
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

// A single memoized grid cell. FlashList RECYCLES the underlying view across
// items as you scroll (like a native UICollectionView) instead of mounting and
// destroying it — that's what makes deep scrolling camera-roll smooth. The cell
// holds NO internal state: everything it shows comes from props derived from
// `item`, and expo-image's recyclingKey={item.id} resets the picture when the
// view is reused for a different asset. onSelect/onRemove arrive as stable refs
// so the memo isn't defeated on every parent render.
const GridCell = memo(function GridCell({
  item, selected, selIndex, isVideo, numbered, isResolving, onSelect, onRemove, styles, spinnerColor,
}: {
  item: MediaLibrary.Asset;
  selected: boolean;
  selIndex: number;
  isVideo: boolean;
  numbered: boolean;
  isResolving: boolean;
  onSelect: (a: MediaLibrary.Asset) => void;
  onRemove?: (id: string) => void;
  styles: any;
  spinnerColor: string;
}) {
  return (
    <View style={styles.slot}>
      <TouchableOpacity
        style={styles.cell}
        activeOpacity={0.85}
        onPress={() => (selected ? onRemove?.(item.id) : onSelect(item))}
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
        {isResolving && (
          <View style={styles.resolving}><ActivityIndicator color={spinnerColor} /></View>
        )}
      </TouchableOpacity>
    </View>
  );
});

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
// Built on FlashList v2 (view recycling) so it scrolls like the native camera
// roll. Thumbnails render the asset's ph:// URI via expo-image (fast, poster
// frames for videos); the chosen asset is resolved to a file:// path only on tap.
// Selected items show a check (single) or an order number (slideshow), and
// tapping a selected item removes it (onRemove).
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
  const listRef = useRef<FlashListRef<any>>(null);
  // Persistent id set so page appends dedupe in O(new-assets) instead of
  // rebuilding a Set over the whole (growing) list every page — that O(N) merge
  // is a big part of why the grid hitched more the deeper you scrolled.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Stable refs so the memoized cell's onSelect/onRemove never change identity.
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const onRemoveRef = useRef(onRemove); onRemoveRef.current = onRemove;
  const resolvingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    scrollToTop: () => listRef.current?.scrollToOffset({ offset: 0, animated: true }),
  }), []);

  // Stable across renders (read live values through refs) — passed to every cell.
  const handleSelect = useCallback(async (asset: MediaLibrary.Asset) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolvingId(asset.id);
    try {
      // Cached across the session (lib/assetInfoCache): re-picking the same asset
      // — common while composing slideshows — is instant, and the iCloud download
      // only ever happens once per asset.
      const uri = await resolveAssetUri(asset);
      const type: 'image' | 'video' = asset.mediaType === MediaLibrary.MediaType.video ? 'video' : 'image';
      // Video posters render reliably from the ph:// asset via expo-image.
      const posterUri = type === 'video' ? asset.uri : uri;
      onPickRef.current({ id: asset.id, uri, posterUri, width: asset.width, height: asset.height, duration: asset.duration, type });
    } catch {
      // A cached localUri can go stale if the asset was edited/deleted — evict so
      // the next tap resolves fresh.
      evictAssetUri(asset.id);
    } finally {
      resolvingRef.current = false;
      setResolvingId(null);
    }
  }, []);
  const handleRemove = useCallback((id: string) => onRemoveRef.current?.(id), []);

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
      // pages (iCloud / edited / shared photos), which would give two cells the
      // same key. A persistent seenIdsRef makes each append O(new assets); a fresh
      // load (no cursor) resets it so page 1 re-seeds from scratch.
      setAssets(prev => {
        const fresh = !after;
        const base = fresh ? [] : prev;
        if (fresh) seenIdsRef.current = new Set();
        const seen = seenIdsRef.current;
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

  // Rebuilt only when the asset list actually changes — NOT on every render (a
  // scroll-driven parent re-render, a loading/resolving toggle), so FlashList
  // isn't handed a fresh data array (and forced to re-diff the whole list) each
  // time.
  const data = useMemo<any[]>(
    () => (videosOnly ? assets : [{ id: '__camera__' } as any, ...assets]),
    [assets, videosOnly],
  );

  const renderItem = useCallback(({ item }: { item: any }) => {
    if (item.id === '__camera__') {
      return (
        <View style={styles.slot}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.camera')} style={[styles.cell, styles.cameraCell]} onPress={openCamera}>
            <Ionicons name="camera" size={26} color={colors.text} />
          </TouchableOpacity>
        </View>
      );
    }
    const selIndex = selectedIds.indexOf(item.id);
    return (
      <GridCell
        item={item}
        selected={selIndex >= 0}
        selIndex={selIndex}
        isVideo={item.mediaType === MediaLibrary.MediaType.video}
        numbered={numbered}
        isResolving={resolvingId === item.id}
        onSelect={handleSelect}
        onRemove={handleRemove}
        styles={styles}
        spinnerColor={colors.text}
      />
    );
  }, [selectedIds, numbered, resolvingId, handleSelect, handleRemove, styles, colors.text]);

  return (
    <FlashList
      ref={listRef}
      data={data}
      keyExtractor={(item) => item.id}
      // Separate recycle pools: the camera tile must never be reused as a thumb
      // cell (different subtree) and vice-versa.
      getItemType={(item) => (item.id === '__camera__' ? 'camera' : 'thumb')}
      numColumns={NUM_COLS}
      renderItem={renderItem}
      contentContainerStyle={styles.gridContent}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => onScrollActive?.(true)}
      onScrollEndDrag={() => onScrollActive?.(false)}
      onMomentumScrollEnd={() => onScrollActive?.(false)}
      onEndReached={() => { if (hasNext && endCursor && !loadingRef.current) loadPage(endCursor); }}
      onEndReachedThreshold={0.6}
      // Render a couple of extra screens of rows ahead of the viewport so a fast
      // fling doesn't outrun decoding. Cheap with recycling — the view pool stays
      // bounded regardless.
      drawDistance={COL_W * 6}
      showsVerticalScrollIndicator={false}
      ListFooterComponent={loading ? <ActivityIndicator color={colors.primary} style={{ margin: SPACING.md }} /> : null}
    />
  );
});

export default PhotoGrid;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  gridContent: { paddingBottom: SPACING.md },
  // Each item is one square slot; the padding is what creates the grid gap
  // (HALF_GAP per side → GAP between neighbours). Spacing lives here, per cell,
  // rather than on a row wrapper or the content container — FlashList has no
  // columnWrapperStyle and per-cell insets recycle cleanly.
  slot: { width: COL_W, height: COL_W, padding: HALF_GAP },
  cell: { flex: 1, backgroundColor: colors.surfaceLight, overflow: 'hidden' },
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
