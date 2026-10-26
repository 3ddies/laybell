import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation, useNavigationState } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import CaptureCamera, { type CaptureCameraHandle, type CapturedMedia } from '../../components/CaptureCamera';
import CollageCamera, { type CollageResult } from '../../components/CollageCamera';
import BoomerangCamera, { type BoomerangResult } from '../../components/BoomerangCamera';
import StoryEditor, { type StoryEditorResult } from '../../components/StoryEditor';
import { bakeFilter } from '../../lib/filterSkia';
import { bakeVideoFilter } from '../../lib/videoFilter';
import { createCollageStory, createBoomerangStory } from '../../lib/stories';
import { useStoryUpload } from '../../contexts/StoryUploadContext';
import { useStories } from '../../contexts/StoriesContext';
import { useProfile } from '../../contexts/ProfileContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { useTranslation } from '../../contexts/LanguageContext';

const VIDEO_MAX_SEC = 60;

type Captured = CapturedMedia;

// The story camera, page 0 of the tab pager (LEFT of Home) so swiping right off Home
// reveals the camera as the background. The live viewfinder is components/CaptureCamera
// — the same one the post composer opens — and a swipe only ever pauses it, never
// unmounts it (mounting/unmounting on each swipe is what froze the app before).
//
// Once something is captured, the editing happens in the SHARED <StoryEditor> (the exact
// same editor the "Add to story" repost flow uses) — this screen owns only the capture
// stage and its lifecycle (pager-swipe locking, the camera teardown, the speculative
// upload), and hands the captured media to that editor.
export default function StoryCameraScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const swiping = usePagerSwiping();
  const setTabSwipe = useTabSwipeControl();
  // Name of the currently-settled tab. While dragging from Home toward the camera
  // it's still 'index' (focus only flips on settle), so we can light up the live
  // camera DURING the drag — without activating it on unrelated tab swipes.
  const focusedTab = useNavigationState((s: any) => s?.routes?.[s.index]?.name);
  const cameraActive = isFocused || (swiping && focusedTab === 'index');
  // Arriving at the camera pauses the user's music — not politeness, accuracy:
  // a song playing out of the speaker records straight into the clip's audio.
  // PAUSE, never stop (useAudioControls).
  const { pause: pauseMainSong } = useAudioControls();
  useEffect(() => { if (isFocused) pauseMainSong(); }, [isFocused, pauseMainSong]);
  const { prewarmStory, enqueueStory, discardPrewarm } = useStoryUpload();
  const { refresh: refreshStories } = useStories();
  const { profile } = useProfile();

  const captureRef = useRef<CaptureCameraHandle>(null);

  const [stage, setStage] = useState<'capture' | 'preview'>('capture');
  // Pager-swipe locking:
  //  • preview/edit: OFF immediately (sticker drags fought the pager — froze).
  //  • live capture: ON for the first 5 seconds (so a quick peek can swipe
  //    straight back to Home), then LOCKED — once someone has dwelled on the
  //    camera they're here to shoot, and pinch/zoom/shutter gestures must
  //    never drag the page away mid-shot. The X button exits while locked.
  //  • leaving the page unlocks and resets the 5s clock for next time.
  useEffect(() => {
    if (!isFocused) { setTabSwipe(true); return; }
    if (stage === 'preview') {
      setTabSwipe(false);
      return () => setTabSwipe(true);
    }
    setTabSwipe(true);
    const timer = setTimeout(() => setTabSwipe(false), 5000);
    return () => { clearTimeout(timer); setTabSwipe(true); };
  }, [isFocused, stage]);

  const [captured, setCaptured] = useState<Captured | null>(null);
  // Prep in the background the instant media is captured: compress + thumbnail +
  // byte upload all start now, so tapping Post is just a row insert (instant).
  useEffect(() => {
    if (captured) prewarmStory(captured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured?.uri]);

  // ── Photo-collage layout (TikTok-style) ──────────────────────────────────────
  // The layout button opens CollageCamera (its own live camera, coordinated by the
  // shared camera-turn); once the grid is filled it becomes a 'collage' media the same
  // StoryEditor edits, and posts through createCollageStory (composed at view time).
  const [collageBuilding, setCollageBuilding] = useState(false);
  const [collage, setCollage] = useState<CollageResult | null>(null);
  const [collageSharing, setCollageSharing] = useState(false);
  // Boomerang: a frame burst looped forward-then-back (createBoomerangStory on post).
  const [boomerangBuilding, setBoomerangBuilding] = useState(false);
  const [boomerang, setBoomerang] = useState<BoomerangResult | null>(null);
  const [boomerangSharing, setBoomerangSharing] = useState(false);
  // Colour filters live in the EDITOR (StoryEditor), not the live camera — they can't preview
  // on the viewfinder, so there's no filter state here.

  // Reset to a clean live viewfinder whenever we leave the page (so re-opening
  // never lands on a stale preview, and any recording is torn down). The editor's
  // own state lives in <StoryEditor>, which unmounts here when we drop back to capture.
  useFocusEffect(
    useCallback(() => {
      return () => {
        captureRef.current?.reset();
        discardPrewarm();
        setStage('capture');
        setCaptured(null);
        setCollage(null);
        setCollageBuilding(false);
        setBoomerang(null);
        setBoomerangBuilding(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function close() {
    navigation.navigate('index');
  }

  function setCapturedMedia(c: Captured) {
    setCaptured(c);
    setStage('preview');
  }

  async function pickFromLibrary() {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 1,
      videoMaxDuration: VIDEO_MAX_SEC,
      // iOS: hand back the ORIGINAL file instead of exporting/transcoding at pick
      // time — the default 'automatic' mode re-encoded HEVC video (and HEIC stills)
      // before returning, which was seconds of dead wait. Safe here: the story upload
      // path re-encodes library images to JPEG itself, and videos ride the existing
      // compress-before-upload path.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setCapturedMedia({
      uri: a.uri,
      type: a.type === 'video' ? 'video' : 'image',
      durationSec: a.duration ? Math.round(a.duration / 1000) : undefined,
      // Natural pixels — drive the drag/pinch crop + the bake on post.
      width: a.width,
      height: a.height,
    });
  }

  // Back out of the editor to the live camera. Dropping `captured` unmounts the shared
  // editor (which stops its music preview + discards its edits); the speculative upload
  // for the abandoned capture is cancelled.
  function retake() {
    discardPrewarm();
    setCaptured(null);
    setCollage(null);
    setBoomerang(null);
    setStage('capture');
  }

  // The editor assembled the full story (caption, song + trim, sticker layers); hand it
  // to the optimistic background upload and return to Home immediately.
  function handleShare(result: StoryEditorResult) {
    if (!captured) return;
    const common = {
      caption: result.caption,
      aspectRatio: result.aspectRatio,
      durationSeconds: result.durationSeconds,
      song: result.song,
      songStartSec: result.songStartSec,
      songClipSec: result.songClipSec,
      stickers: result.stickers.length ? result.stickers : null,
    };
    if (result.filter !== 'original' && captured.type === 'image') {
      // A color filter is BAKED into the pixels before upload (RN's `filter` style can't
      // render color effects on iOS). Deferred so the UI returns instantly; the optimistic
      // upload just starts once the bake lands (the unfiltered prewarm is dropped by retake).
      const orig = captured;
      (async () => {
        let uri = orig.uri;
        // Full source resolution, high JPEG quality — a filtered photo must look as sharp as
        // an unfiltered one (a size cap here used to make them look soft).
        try { uri = await bakeFilter(orig.uri, result.filter, undefined, 95); } catch {}
        enqueueStory({ captured: { ...orig, uri }, ...common });
      })();
    } else if (result.filter !== 'original' && captured.type === 'video') {
      // A video can't be colour-filtered live at playback, so the look is baked into the
      // clip before upload (native exporter). Deferred like the photo bake so the UI returns
      // instantly; bakeVideoFilter no-ops to the original on a build that can't bake.
      const orig = captured;
      (async () => {
        const uri = await bakeVideoFilter(orig.uri, result.filter);
        enqueueStory({ captured: { ...orig, uri }, ...common });
      })();
    } else {
      enqueueStory({ captured, ...common }); // unfiltered: claim the prewarm synchronously (instant)
    }
    retake();
    navigation.navigate('index');
  }

  // A photo collage posts directly (its slot images are hosted + the grid composed at
  // view time) rather than through the optimistic single-file upload.
  async function handleCollageShare(result: StoryEditorResult) {
    if (!profile?.id || collageSharing) return;
    setCollageSharing(true);
    try {
      await createCollageStory({
        userId: profile.id,
        layers: result.stickers,
        caption: result.caption,
        song: result.song,
        songStartSec: result.songStartSec,
        songClipSec: result.songClipSec,
      });
      refreshStories();
      setCollageSharing(false);
      retake();
      navigation.navigate('index');
    } catch {
      setCollageSharing(false);
      Alert.alert(t('common.error'), t('postOptions.postToStoryFailed'));
    }
  }

  // A boomerang posts directly too (its frames are hosted + looped at view time).
  async function handleBoomerangShare(result: StoryEditorResult) {
    if (!profile?.id || boomerangSharing) return;
    setBoomerangSharing(true);
    try {
      await createBoomerangStory({
        userId: profile.id,
        layers: result.stickers,
        caption: result.caption,
        song: result.song,
        songStartSec: result.songStartSec,
        songClipSec: result.songClipSec,
      });
      refreshStories();
      setBoomerangSharing(false);
      retake();
      navigation.navigate('index');
    } catch {
      setBoomerangSharing(false);
      Alert.alert(t('common.error'), t('postOptions.postToStoryFailed'));
    }
  }

  // components/CaptureCamera stays mounted (camera closed, settings kept) while the editor
  // shows a capture — mounting/unmounting it on each swipe is what froze the app before.
  // The collage builder (its own camera) overlays it; the shared camera-turn hands the one
  // live CameraView between them.
  return (
    <>
      <CaptureCamera
        ref={captureRef}
        active={cameraActive && !collageBuilding && !boomerangBuilding}
        focused={isFocused}
        hidden={stage === 'preview' || collageBuilding || boomerangBuilding}
        maxVideoSec={VIDEO_MAX_SEC}
        onCapture={setCapturedMedia}
        onClose={close}
        onLibrary={pickFromLibrary}
        onLayout={() => setCollageBuilding(true)}
        onBoomerang={() => setBoomerangBuilding(true)}
        closeLabel={t('storyCamera.backToFeed')}
      />
      {collageBuilding && (
        <CollageCamera
          onClose={() => setCollageBuilding(false)}
          onComplete={(result) => { setCollage(result); setCollageBuilding(false); setStage('preview'); }}
        />
      )}
      {boomerangBuilding && (
        <BoomerangCamera
          onClose={() => setBoomerangBuilding(false)}
          onComplete={(result) => { setBoomerang(result); setBoomerangBuilding(false); setStage('preview'); }}
        />
      )}
      {stage === 'preview' && captured && (
        <StoryEditor
          key={captured.uri}
          media={{ kind: 'captured', captured }}
          onClose={retake}
          onShare={handleShare}
        />
      )}
      {stage === 'preview' && collage && (
        <StoryEditor
          key={collage.slots[0] ?? 'collage'}
          media={{ kind: 'collage', layout: collage.layout, slots: collage.slots }}
          onClose={retake}
          onShare={handleCollageShare}
          sharing={collageSharing}
        />
      )}
      {stage === 'preview' && boomerang && (
        <StoryEditor
          key={boomerang.frames[0] ?? 'boomerang'}
          media={{ kind: 'boomerang', frames: boomerang.frames }}
          onClose={retake}
          onShare={handleBoomerangShare}
          sharing={boomerangSharing}
        />
      )}
    </>
  );
}
