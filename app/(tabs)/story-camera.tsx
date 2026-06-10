import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Image, TextInput, Linking,
} from 'react-native';
import {
  CameraView, CameraType, FlashMode,
  useCameraPermissions, useMicrophonePermissions,
} from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { manipulateAsync, SaveFormat, FlipType } from 'expo-image-manipulator';
import { useIsFocused, useNavigation, useNavigationState } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { uploadStoryMedia, createStory } from '../../lib/stories';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import MentionSuggestions from '../../components/MentionSuggestions';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { useStories } from '../../contexts/StoriesContext';
import { usePagerSwiping } from '../../contexts/PagerContext';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

const VIDEO_MAX_SEC = 60;

type Captured = { uri: string; type: 'image' | 'video'; durationSec?: number; processed?: boolean };
type Mode = 'picture' | 'video';

// The live story camera, page 0 of the tab pager (LEFT of Home) so swiping right
// off Home reveals the camera as the background. CameraView is ALWAYS mounted and
// paused via `active={isFocused}` — mounting/unmounting it on each swipe is what
// froze the app before, so we never unmount it; we just pause it.
export default function StoryCameraScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const swiping = usePagerSwiping();
  // Name of the currently-settled tab. While dragging from Home toward the camera
  // it's still 'index' (focus only flips on settle), so we can light up the live
  // camera DURING the drag — without activating it on unrelated tab swipes.
  const focusedTab = useNavigationState((s: any) => s?.routes?.[s.index]?.name);
  const cameraActive = isFocused || (swiping && focusedTab === 'index');
  const { refresh: refreshStories } = useStories();

  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [mode, setMode] = useState<Mode>('picture');

  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recSecsRef = useRef(0);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [stage, setStage] = useState<'capture' | 'preview'>('capture');
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [caption, setCaption] = useState('');
  const [song, setSong] = useState<PickedSong | null>(null);
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Ask for camera access the first time you actually open the camera.
  useEffect(() => {
    if (isFocused && camPermission && !camPermission.granted && camPermission.canAskAgain) {
      requestCamPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, camPermission]);

  // Reset to a clean live viewfinder whenever we leave the page (so re-opening
  // never lands on a stale preview, and any recording is torn down).
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
        if (recording) cameraRef.current?.stopRecording();
        setRecording(false);
        setRecSecs(0);
        setStage('capture');
        setCaptured(null);
        setCaption('');
        setSong(null);
        setMode('picture');
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function close() {
    navigation.navigate('index');
  }

  async function toggleMode() {
    const next: Mode = mode === 'picture' ? 'video' : 'picture';
    if (next === 'video' && micPermission && !micPermission.granted && micPermission.canAskAgain) {
      await requestMicPermission();
    }
    setMode(next);
  }

  async function takePhoto() {
    try {
      // Capture at full quality, then do ONE manipulate pass: front-camera shots
      // are flipped to match the mirrored preview (expo-camera saves them
      // un-mirrored by default), downscaled to 1080-wide story res, and compressed.
      // A single re-encode (not the old double compression) keeps quality high.
      const photo = await cameraRef.current?.takePictureAsync({ quality: 1 });
      if (!photo?.uri) return;
      const front = facing === 'front';
      let uri = photo.uri;
      try {
        const out = await manipulateAsync(
          photo.uri,
          [
            ...(front ? [{ flip: FlipType.Horizontal }] : []),
            { resize: { width: 1440 } },
          ],
          { compress: 0.92, format: SaveFormat.JPEG },
        );
        uri = out.uri;
      } catch {}
      setCapturedMedia({ uri, type: 'image', processed: true });
    } catch (e: any) {
      Alert.alert('Could not take photo', e?.message ?? 'Please try again.');
    }
  }

  async function startRecording() {
    if (recording) return;
    setRecording(true);
    setRecSecs(0);
    recSecsRef.current = 0;
    recTimer.current = setInterval(() => { recSecsRef.current += 1; setRecSecs(recSecsRef.current); }, 1000);
    try {
      const video = await cameraRef.current?.recordAsync({ maxDuration: VIDEO_MAX_SEC });
      if (video?.uri) {
        setCapturedMedia({ uri: video.uri, type: 'video', durationSec: recSecsRef.current || undefined });
      }
    } catch (e: any) {
      Alert.alert('Could not record video', e?.message ?? 'Please try again.');
    } finally {
      if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
      setRecording(false);
    }
  }

  function stopRecording() {
    if (!recording) return;
    cameraRef.current?.stopRecording();
  }

  function setCapturedMedia(c: Captured) {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    setRecording(false);
    setCaptured(c);
    setStage('preview');
  }

  function onShutterPress() {
    if (mode === 'video') {
      recording ? stopRecording() : startRecording();
    } else {
      takePhoto();
    }
  }

  async function pickFromLibrary() {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.9,
      videoMaxDuration: VIDEO_MAX_SEC,
    });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setCapturedMedia({
      uri: a.uri,
      type: a.type === 'video' ? 'video' : 'image',
      durationSec: a.duration ? Math.round(a.duration / 1000) : undefined,
    });
  }

  function retake() {
    setCaptured(null);
    setCaption('');
    setSong(null);
    setStage('capture');
  }

  async function shareStory() {
    if (!captured) return;
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let mediaUrl: string;
      let thumbnailUrl: string | null = null;

      if (captured.type === 'image') {
        let outUri = captured.uri;
        // Camera shots are already processed in takePhoto; only library picks
        // still need the downscale/compress pass here.
        if (!captured.processed) {
          try {
            const out = await manipulateAsync(captured.uri, [{ resize: { width: 1440 } }], {
              compress: 0.92, format: SaveFormat.JPEG,
            });
            outUri = out.uri;
          } catch {}
        }
        mediaUrl = await uploadStoryMedia(user.id, outUri, 'jpg', 'image/jpeg');
      } else {
        const ext = captured.uri.split('.').pop() || 'mp4';
        mediaUrl = await uploadStoryMedia(user.id, captured.uri, ext, 'video/mp4');
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(captured.uri, { time: 0 });
          thumbnailUrl = await uploadStoryMedia(user.id, uri, 'jpg', 'image/jpeg');
        } catch {}
      }

      await createStory({
        userId: user.id,
        mediaUrl,
        mediaType: captured.type,
        thumbnailUrl,
        caption: caption.trim() || null,
        aspectRatio: '9:16',
        durationSeconds: captured.type === 'video' ? captured.durationSec ?? null : null,
        song,
      });

      retake();
      refreshStories();
      navigation.navigate('index');
    } catch (e: any) {
      Alert.alert('Could not post story', e?.message ?? 'Please try again.');
    } finally {
      setUploading(false);
    }
  }

  // ─── Permission gate ─────────────────────────────────────────────────────
  if (camPermission && !camPermission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Ionicons name="camera-outline" size={48} color={COLORS.textTertiary} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permSub}>Allow camera access to capture stories.</Text>
        <TouchableOpacity
          style={styles.permBtn}
          onPress={() => (camPermission.canAskAgain ? requestCamPermission() : Linking.openSettings())}
        >
          <Text style={styles.permBtnText}>
            {camPermission.canAskAgain ? 'Allow camera' : 'Open settings'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permClose} onPress={close}>
          <Text style={styles.permCloseText}>Back to feed</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Preview / confirm ───────────────────────────────────────────────────
  if (stage === 'preview' && captured) {
    return (
      <View style={styles.container}>
        {captured.type === 'image' ? (
          <Image source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Video
            source={{ uri: captured.uri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.COVER}
            shouldPlay
            isLooping
            isMuted={false}
          />
        )}

        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={retake}>
          <Ionicons name="arrow-back" size={26} color="#fff" />
        </TouchableOpacity>

        <View style={[styles.previewBottom, { paddingBottom: insets.bottom + SPACING.md }]}>
          {song ? (
            <View style={styles.songPill}>
              <Ionicons name="musical-notes" size={15} color="#fff" />
              <Text style={styles.songPillText} numberOfLines={1}>{song.artist} · {song.title}</Text>
              <TouchableOpacity onPress={() => setSong(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.musicBtn} onPress={() => setShowSongPicker(true)}>
              <Ionicons name="musical-notes-outline" size={18} color="#fff" />
              <Text style={styles.musicBtnText}>Add music</Text>
            </TouchableOpacity>
          )}
          <MentionSuggestions
            query={getActiveMentionQuery(caption, caption.length)}
            onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
            style={{ marginBottom: SPACING.xs }}
            maxHeight={150}
          />
          <TextInput
            style={styles.captionInput}
            placeholder="Add a caption…"
            placeholderTextColor="rgba(255,255,255,0.7)"
            value={caption}
            onChangeText={setCaption}
            maxLength={200}
          />
          <TouchableOpacity style={styles.shareBtn} onPress={shareStory} disabled={uploading}>
            {uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={styles.shareBtnText}>Add to story</Text>
                <Ionicons name="arrow-forward-circle" size={22} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </View>
        <SongPickerModal visible={showSongPicker} onClose={() => setShowSongPicker(false)} onSelect={setSong} />
      </View>
    );
  }

  // ─── Live capture ────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {camPermission?.granted ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          flash={flash}
          enableTorch={mode === 'video' && recording && flash !== 'off'}
          mode={mode}
          // Record at Full HD (falls back to the highest the device supports) so
          // story videos aren't soft.
          videoQuality="1080p"
          mute={!micPermission?.granted}
          active={cameraActive}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      {/* Top controls */}
      <View style={[styles.topRow, { top: insets.top + 8 }]}>
        <TouchableOpacity style={styles.roundBtn} onPress={close}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
        <View style={styles.topRight}>
          <TouchableOpacity
            style={styles.roundBtn}
            onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
          >
            <Ionicons name={flash === 'off' ? 'flash-off' : 'flash'} size={24} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.roundBtn}
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          >
            <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Recording timer */}
      {recording && (
        <View style={[styles.recPill, { top: insets.top + 12 }]}>
          <View style={styles.recDot} />
          <Text style={styles.recText}>{fmtClock(recSecs)}</Text>
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + SPACING.md }]}>
        {!recording && (
          <View style={styles.modeRow}>
            {(['picture', 'video'] as Mode[]).map((m) => (
              <TouchableOpacity key={m} onPress={() => m !== mode && toggleMode()} style={styles.modePill}>
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                  {m === 'picture' ? 'PHOTO' : 'VIDEO'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.shutterRow}>
          <TouchableOpacity style={styles.galleryBtn} onPress={pickFromLibrary} disabled={recording}>
            <Ionicons name="images-outline" size={26} color={recording ? COLORS.textTertiary : '#fff'} />
          </TouchableOpacity>

          <TouchableOpacity activeOpacity={0.8} onPress={onShutterPress} style={styles.shutterOuter}>
            <View
              style={[
                styles.shutterInner,
                mode === 'video' && styles.shutterInnerVideo,
                recording && styles.shutterInnerRecording,
              ]}
            />
          </TouchableOpacity>

          <View style={styles.galleryBtn} />
        </View>
      </View>
    </View>
  );
}

function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SHUTTER = 76;

const styles = StyleSheet.create({
  // Absolute-fill (not flex:1) so it ignores the navigator's sceneContainerStyle
  // bottom padding and stays edge-to-edge — full-screen camera, no gray slot.
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },

  permTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700', marginTop: SPACING.sm },
  permSub: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  permBtn: {
    marginTop: SPACING.md, backgroundColor: COLORS.primary,
    borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.xl,
  },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  permClose: { marginTop: SPACING.sm, padding: SPACING.sm },
  permCloseText: { color: COLORS.textSecondary, fontSize: 14 },

  topRow: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  recPill: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.error },
  recText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },

  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: SPACING.md },

  modeRow: { flexDirection: 'row', gap: SPACING.lg },
  modePill: { paddingHorizontal: SPACING.sm, paddingVertical: 4 },
  modeText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  modeTextActive: { color: COLORS.primaryLight },

  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingHorizontal: SPACING.xl },
  galleryBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },

  shutterOuter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: {
    width: SHUTTER - 16, height: SHUTTER - 16, borderRadius: (SHUTTER - 16) / 2,
    backgroundColor: '#fff',
  },
  shutterInnerVideo: { backgroundColor: COLORS.error },
  shutterInnerRecording: { width: 28, height: 28, borderRadius: 6, backgroundColor: COLORS.error },

  previewBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: SPACING.md, gap: SPACING.sm },
  captionInput: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md,
    color: '#fff', fontSize: 15, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
  },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.md,
  },
  shareBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  musicBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm + 2, alignSelf: 'flex-start', paddingHorizontal: SPACING.md,
  },
  musicBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  songPill: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.md, alignSelf: 'flex-start', maxWidth: '100%',
  },
  songPillText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
});
