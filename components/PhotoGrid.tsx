import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, Dimensions, ActivityIndicator,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING } from '../constants/theme';

const NUM_COLS = 4;
const GAP = 2;
const SCREEN_W = Dimensions.get('window').width;
const CELL = (SCREEN_W - GAP * (NUM_COLS - 1)) / NUM_COLS;
const PAGE = 18;

export type PickedMedia = { uri: string; width: number; height: number; type: 'image' | 'video' };

// A gallery item already resolved to a usable file:// URI (never ph://, which
// RN's image pipeline can't load).
type GalleryItem = { id: string; uri: string; width: number; height: number; duration: number };

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Device camera-roll grid (like Instagram's picker). Each asset is resolved to a
// local file:// URI before display, so iOS `ph://` URIs never reach <Image>.
export default function PhotoGrid({ mediaType, onPick }: {
  mediaType: 'image' | 'video';
  onPick: (m: PickedMedia) => void;
}) {
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const mlType = mediaType === 'video' ? MediaLibrary.MediaType.video : MediaLibrary.MediaType.photo;

  const resolveAsset = useCallback(async (a: MediaLibrary.Asset): Promise<GalleryItem | null> => {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(a);
      const uri = info.localUri || a.uri;
      if (!uri || uri.startsWith('ph://')) return null; // unusable for <Image>/manipulate
      return { id: a.id, uri, width: a.width, height: a.height, duration: a.duration };
    } catch {
      return null;
    }
  }, []);

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
      const resolved = (await Promise.all(page.assets.map(resolveAsset))).filter(Boolean) as GalleryItem[];
      setItems(prev => (after ? [...prev, ...resolved] : resolved));
      setEndCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch {
      // ignore — empty state will show
    }
    loadingRef.current = false;
    setLoading(false);
  }, [mlType, resolveAsset]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let p = permission;
      if (!p || !p.granted) p = await requestPermission();
      if (cancelled || !p?.granted) return;
      setItems([]); setEndCursor(undefined); setHasNext(true);
      loadPage(undefined);
    })();
    return () => { cancelled = true; };
  }, [mediaType]);

  async function openCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: mediaType === 'video' ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      onPick({ uri: a.uri, width: a.width ?? 1, height: a.height ?? 1, type: mediaType });
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

  const data: any[] = [{ id: '__camera__' }, ...items];

  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      numColumns={NUM_COLS}
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={{ gap: GAP }}
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
          <TouchableOpacity
            style={styles.cell}
            activeOpacity={0.85}
            onPress={() => onPick({ uri: item.uri, width: item.width, height: item.height, type: mediaType })}
          >
            <Image source={{ uri: item.uri }} style={styles.thumb} />
            {mediaType === 'video' && item.duration > 0 && (
              <Text style={styles.dur}>{formatDur(item.duration)}</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg, gap: SPACING.md },
  permText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  permBtn: { backgroundColor: COLORS.primary, borderRadius: 999, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg },
  permBtnText: { color: COLORS.text, fontWeight: '700' },
});
