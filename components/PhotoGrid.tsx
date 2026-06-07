import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

const NUM_COLS = 4;
const GAP = 2;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS - 1)) / NUM_COLS;
const PAGE = 60;

export type PickedMedia = {
  uri: string;            // file:// — for cropping/upload
  posterUri?: string;     // ph:// (video) shown as a still preview via expo-image
  width: number;
  height: number;
  type: 'image' | 'video';
};

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Device camera-roll grid (Instagram-style). Thumbnails render the asset's ph://
// URI directly via expo-image (fast, shows poster frames for videos — no full
// export). The chosen asset is resolved to a file:// path only on tap, for the
// cropper / manipulator / upload (which can't read ph://).
export default function PhotoGrid({ mediaType, onPick, onScroll }: {
  mediaType: 'image' | 'video';
  onPick: (m: PickedMedia) => void;
  onScroll?: (e: any) => void;
}) {
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const mlType = mediaType === 'video' ? MediaLibrary.MediaType.video : MediaLibrary.MediaType.photo;

  const loadPage = useCallback(async (after?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: [mlType],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        first: PAGE,
        after,
      });
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setEndCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch {
      // ignore — empty state will show
    }
    loadingRef.current = false;
    setLoading(false);
  }, [mlType]);

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
  }, [mediaType]);

  async function selectAsset(asset: MediaLibrary.Asset) {
    if (resolvingId) return;
    setResolvingId(asset.id);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri || asset.uri;
      // Video posters render reliably from the ph:// asset via expo-image.
      const posterUri = mediaType === 'video' ? asset.uri : uri;
      onPick({ uri, posterUri, width: asset.width, height: asset.height, type: mediaType });
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
      mediaTypes: mediaType === 'video' ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      // Camera video has no ph:// poster — post.tsx falls back to a generated thumbnail.
      onPick({ uri: a.uri, posterUri: mediaType === 'video' ? undefined : a.uri, width: a.width ?? 1, height: a.height ?? 1, type: mediaType });
    }
  }

  if (permission && !permission.granted) {
    return (
      <View style={styles.center}>
        <Ionicons name="images-outline" size={36} color={COLORS.textTertiary} />
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
      onEndReached={() => { if (hasNext && endCursor && !loadingRef.current) loadPage(endCursor); }}
      onEndReachedThreshold={0.6}
      ListFooterComponent={loading ? <ActivityIndicator color={COLORS.primary} style={{ margin: SPACING.md }} /> : null}
      renderItem={({ item }) => {
        if (item.id === '__camera__') {
          return (
            <TouchableOpacity style={[styles.cell, styles.cameraCell]} onPress={openCamera}>
              <Ionicons name="camera" size={26} color={COLORS.text} />
            </TouchableOpacity>
          );
        }
        return (
          <TouchableOpacity style={styles.cell} activeOpacity={0.85} onPress={() => selectAsset(item)}>
            <ExpoImage
              source={{ uri: item.uri }}
              style={styles.thumb}
              contentFit="cover"
              recyclingKey={item.id}
              transition={120}
            />
            {mediaType === 'video' && item.duration > 0 && (
              <Text style={styles.dur}>{formatDur(item.duration)}</Text>
            )}
            {resolvingId === item.id && (
              <View style={styles.resolving}><ActivityIndicator color={COLORS.text} /></View>
            )}
          </TouchableOpacity>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  cell: { width: CELL, height: CELL, backgroundColor: COLORS.surfaceLight },
  cameraCell: { alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceElevated },
  thumb: { width: '100%', height: '100%' },
  dur: {
    position: 'absolute', bottom: 4, right: 4, color: '#fff', fontSize: 11, fontWeight: '700',
    textShadowColor: '#000', textShadowRadius: 3,
  },
  resolving: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg, gap: SPACING.md },
  permText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  permBtn: { backgroundColor: COLORS.primary, borderRadius: 999, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg },
  permBtnText: { color: COLORS.text, fontWeight: '700' },
});
