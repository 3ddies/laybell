import { useEffect, useState, useCallback } from 'react';
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

export type PickedMedia = { uri: string; width: number; height: number; type: 'image' | 'video' };

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Device camera-roll grid (like Instagram's picker). Tapping a thumbnail resolves
// its localUri and hands it back via onPick; a leading tile opens the camera.
export default function PhotoGrid({ mediaType, onPick }: {
  mediaType: 'image' | 'video';
  onPick: (m: PickedMedia) => void;
}) {
  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);

  const mlType = mediaType === 'video' ? MediaLibrary.MediaType.video : MediaLibrary.MediaType.photo;

  const loadPage = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: [mlType],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        first: 60,
        after,
      });
      setAssets(prev => (after ? [...prev, ...page.assets] : page.assets));
      setEndCursor(page.endCursor);
      setHasNext(page.hasNextPage);
    } catch {
      // ignore — empty state will show
    }
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
    if (resolving) return;
    setResolving(true);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      onPick({ uri: info.localUri || asset.uri, width: asset.width, height: asset.height, type: mediaType });
    } finally {
      setResolving(false);
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

  const data: any[] = [{ id: '__camera__' }, ...assets];

  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      numColumns={NUM_COLS}
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={{ gap: GAP }}
      onEndReached={() => { if (hasNext && endCursor && !loading) loadPage(endCursor); }}
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
