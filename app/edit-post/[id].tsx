import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { GENRES, genreLabel, isAudioPost } from '../../lib/genres';
import { applyMention, extractMentionUsernames, getActiveMentionQuery, processMentions } from '../../lib/mentions';
import { createNotification } from '../../lib/createNotification';
import { checkFields } from '../../lib/contentFilter';
import { parseFeatures, type Feature } from '../../lib/features';
import { parseSlides } from '../../lib/slideshow';
import { aspectToNumber } from '../../lib/aspectRatio';
import { isTimed, postStickers, splitForPublish, timingForPublish } from '../../lib/stickerTiming';
import { bandStickersFromLegacy, isBandSticker, legacyBandCaption } from '../../lib/bandCaptions';
import { mixColumns, mixFromPost, type SongMix } from '../../lib/songMix';
import { formatSchedule } from '../../lib/schedule';
import { cancelLiveReminder, scheduleLiveReminder } from '../../lib/scheduleNotify';
import { emitPostEdited } from '../../lib/postEdits';
import { cfStreamThumbnail } from '../../lib/cast';
import { notifySuccess } from '../../lib/haptics';
import MentionSuggestions from '../../components/MentionSuggestions';
import { Skeleton, SkeletonLine } from '../../components/Skeleton';
import TagPeopleModal, { type TaggedPerson } from '../../components/TagPeopleModal';
import SongPickerModal from '../../components/SongPickerModal';
import FeaturesModal from '../../components/FeaturesModal';
import SchedulePicker from '../../components/SchedulePicker';
import SlideUpSheet from '../../components/SlideUpSheet';
import ConfirmDialog from '../../components/ConfirmDialog';
import VideoStudio, { type StudioResult } from '../../components/VideoStudio';
import type { PickedSong } from '../../components/SongBrowser';
import type { Sticker } from '../../components/StickerLayer';

// Editing a post that is already up — or scheduled. Owner's call, 2026-09-11:
// everything but the file itself. The caption, tags and credits, the genre, who
// sees it, the song, and the post's settings; on a video, the captions on it, its
// music and sound mix and its cover, in the same studio the composer uses
// (components/VideoStudio, reopened on the posted stream); on a track, its cover
// art and category; on a scheduled post, when it goes live.
//
// Only what changed is written, so an edit touches no column it did not mean to —
// the community guard, for one, fires on is_public. People an edit newly involves
// (a new @mention, a new tag or credit, a new song's artist) hear about it the way
// they would have from the original post, once; a scheduled post's are the
// server's to send when it goes up (supabase/sql/post_scheduling.sql).

type IconName = ComponentProps<typeof Ionicons>['name'];
type PostRow = Record<string, any>;
type AudioKind = 'audio' | 'podcast' | 'audiobook';

// The state the screen opened with, to tell what an edit changed.
type Snapshot = {
  caption: string;
  isPublic: boolean;
  genre: string; // the stored lowercase value, '' for none
  mature: boolean;
  allowGifs: boolean;
  downloadable: boolean;
  filmTitle: string;
  audioKind: string;
  tagged: TaggedPerson[];
  features: Feature[];
  song: PickedSong | null;
  musicVideo: boolean;
  mix: (SongMix & { songId: string }) | null;
  stickers: Sticker[];
  cover: string | null; // a video's thumbnail_url, a track's cover_url
  publishAt: number | null;
};

// A post past this is a film (supabase/sql/premium_plus.sql) and has a shelf title.
const FILM_SECONDS = 540;
const CAPTION_MAX = 500;
const TITLE_MAX = 80;
const AUDIO_KINDS: { val: AudioKind; icon: IconName }[] = [
  { val: 'audio', icon: 'musical-notes' },
  { val: 'podcast', icon: 'mic' },
  { val: 'audiobook', icon: 'book' },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isLocalFile = (uri: string | null | undefined): uri is string => !!uri && !/^https?:\/\//i.test(uri);

// A video's captions as the studio edits them. A horizontal clip's are band
// captions (lib/bandCaptions) — or, from before those, its one bubble per band.
// Captions from before a caption had an id still need one to be edited.
function captionsToEdit(post: PostRow): Sticker[] {
  const all = postStickers<Sticker>(post.captions, post.timed_captions);
  const horizontal = post.type === 'video' && aspectToNumber(post.aspect_ratio, 16 / 9) > 1;
  const list: Sticker[] = !horizontal
    ? all.filter((k) => !isBandSticker(k))
    : all.some(isBandSticker)
      ? all.filter(isBandSticker)
      : bandStickersFromLegacy(post.top_caption, post.bottom_caption);
  return list.map((k, i) => ({ ...k, id: k.id || `vc-edit-${i}` }));
}

// A cover chosen from the camera roll, into the same bucket the composer's posters use.
async function uploadImage(userId: string, uri: string): Promise<string> {
  const name = `${Date.now()}.jpg`;
  const path = `${userId}/${name}`;
  const form = new FormData();
  form.append('file', { uri, name, type: 'image/jpeg' } as any);
  const { error } = await supabase.storage.from('posts').upload(path, form, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
}

export default function EditPostScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, lang } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { stop: stopMainAudio } = useAudioControls();

  const [row, setRow] = useState<PostRow | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [caption, setCaption] = useState('');
  const [cursor, setCursor] = useState(0);
  const [isPublic, setIsPublic] = useState(true);
  const [genre, setGenre] = useState('');
  const [mature, setMature] = useState(false);
  const [allowGifs, setAllowGifs] = useState(true);
  const [downloadable, setDownloadable] = useState(true);
  const [filmTitle, setFilmTitle] = useState('');
  const [audioKind, setAudioKind] = useState<string>('audio');
  const [tagged, setTagged] = useState<TaggedPerson[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [song, setSong] = useState<PickedSong | null>(null);
  const [musicVideo, setMusicVideo] = useState(false);
  const [mix, setMix] = useState<(SongMix & { songId: string }) | null>(null);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [cover, setCover] = useState<string | null>(null);
  const [coverSec, setCoverSec] = useState<number | null>(null);
  const [publishAt, setPublishAt] = useState<number | null>(null);
  const [wasScheduled, setWasScheduled] = useState(false);

  const [studio, setStudio] = useState<'open' | 'cover' | null>(null);
  const [showTags, setShowTags] = useState(false);
  const [showSongs, setShowSongs] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const [showGenres, setShowGenres] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Saved, or discard confirmed: leave without asking again.
  const [leaving, setLeaving] = useState<null | { action?: any }>(null);
  const [confirmLeave, setConfirmLeave] = useState<any>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: post } = await supabase.from('posts').select('*').eq('id', id).maybeSingle();
    if (!post) { Alert.alert(t('editPost.notFoundTitle'), t('editPost.notFoundBody')); router.back(); return; }
    if (!user || post.user_id !== user.id) {
      Alert.alert(t('editPost.notAllowedTitle'), t('editPost.notAllowedBody')); router.back(); return;
    }

    const taggedIds: string[] = Array.isArray(post.tagged_user_ids) ? post.tagged_user_ids : [];
    let people: TaggedPerson[] = [];
    if (taggedIds.length) {
      const { data } = await supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', taggedIds);
      const byId = new Map((data ?? []).map((p: any) => [p.id, p as TaggedPerson]));
      people = taggedIds.map((pid) => byId.get(pid)).filter((p): p is TaggedPerson => !!p);
    }
    const postMix = mixFromPost(post);
    const s: Snapshot = {
      caption: post.caption ?? '',
      isPublic: post.is_public ?? true,
      genre: typeof post.genre === 'string' ? post.genre.toLowerCase() : '',
      mature: !!post.mature,
      allowGifs: post.allow_gifs !== false,
      downloadable: post.downloadable !== false,
      filmTitle: post.film_title ?? '',
      audioKind: post.type,
      tagged: people,
      features: parseFeatures(post.features),
      song: post.song_id
        ? { id: post.song_id, title: post.song_title ?? '', artist: post.song_artist ?? '', artistId: post.song_artist_id ?? '' }
        : null,
      musicVideo: !!post.song_link_only,
      mix: post.song_id && postMix.custom
        ? { startSec: postMix.startSec, songVolume: postMix.songVolume, videoVolume: postMix.videoVolume, songId: post.song_id }
        : null,
      stickers: captionsToEdit(post),
      cover: post.type === 'video' ? (post.thumbnail_url ?? null) : isAudioPost(post.type) ? (post.cover_url ?? null) : null,
      publishAt: post.publish_at ? new Date(post.publish_at).getTime() : null,
    };

    setRow(post);
    setSnap(s);
    setCaption(s.caption); setCursor(s.caption.length);
    setIsPublic(s.isPublic); setGenre(s.genre); setMature(s.mature);
    setAllowGifs(s.allowGifs); setDownloadable(s.downloadable); setFilmTitle(s.filmTitle);
    setAudioKind(s.audioKind); setTagged(s.tagged); setFeatures(s.features);
    setSong(s.song); setMusicVideo(s.musicVideo); setMix(s.mix);
    setStickers(s.stickers); setCover(s.cover);
    setPublishAt(s.publishAt);
    setWasScheduled(s.publishAt != null && s.publishAt > Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const type: string = row?.type ?? '';
  const isVideo = type === 'video';
  const isAudio = isAudioPost(type);
  const isPicture = type === 'image' || type === 'slideshow';
  const hasCommunity = Array.isArray(row?.community_ids) && row!.community_ids.length > 0;
  // A video without a recorded shape is edited as the reel and the feed show it: 16:9.
  const aspect = aspectToNumber(row?.aspect_ratio, isVideo ? 16 / 9 : 1);
  const horizontal = isVideo && aspect > 1;
  const duration = Number(row?.duration_seconds) || 0;
  const isFilm = isVideo && duration > FILM_SECONDS;
  // The window the post plays, on the clock its captions are timed on: a virtual
  // trim keeps the source's clock; a physically cut file starts at 0.
  const trimStart = typeof row?.trim_start === 'number' ? row.trim_start : null;
  const trimEnd = typeof row?.trim_end === 'number' ? row.trim_end : null;
  const winStart = trimStart ?? 0;
  const winEnd = trimStart != null ? (trimEnd != null && trimEnd > trimStart ? trimEnd : trimStart + duration) : duration;
  // A video still encoding has no stream to open yet.
  const videoReady = isVideo && !!row?.media_url && (row?.video_status == null || row?.video_status === 'ready');

  // Stop the main player while the studio plays the clip and its song.
  useEffect(() => { if (studio) stopMainAudio(); }, [studio, stopMainAudio]);

  // ── What the edit changes ──────────────────────────────────────────────────
  function buildUpdate(): Record<string, unknown> {
    const s = snap;
    if (!s || !row) return {};
    const u: Record<string, unknown> = {};
    const cap = caption.trim();
    if (cap !== s.caption.trim()) u.caption = cap;
    if (!hasCommunity && isPublic !== s.isPublic) u.is_public = isPublic;
    if (!hasCommunity && genre !== s.genre) u.genre = genre || null;
    if (mature !== s.mature) u.mature = mature;
    if (isVideo && allowGifs !== s.allowGifs) u.allow_gifs = allowGifs;
    if (isAudio && downloadable !== s.downloadable) u.downloadable = downloadable;
    if (isFilm && filmTitle.trim() !== s.filmTitle.trim()) u.film_title = filmTitle.trim() || null;
    if (isAudio && audioKind !== s.audioKind) u.type = audioKind;
    if (!isAudio && !same(tagged.map((p) => p.id), s.tagged.map((p) => p.id))) u.tagged_user_ids = tagged.map((p) => p.id);
    if (isAudio && !same(features, s.features)) u.features = features;

    const songChanged = (!isAudio && (song?.id ?? null) !== (s.song?.id ?? null)) || (isVideo && musicVideo !== s.musicVideo);
    if (songChanged) {
      Object.assign(u, song
        ? { song_id: song.id, song_title: song.title, song_artist: song.artist, song_artist_id: song.artistId || null, song_link_only: isVideo && musicVideo }
        : { song_id: null, song_title: null, song_artist: null, song_artist_id: null, song_link_only: false });
    }
    if (isVideo) {
      // A music video's song never plays, so it keeps no mix.
      const mixNow = song && !musicVideo && mix && mix.songId === song.id ? mixColumns(mix) : null;
      const mixWas = s.song && !s.musicVideo && s.mix ? mixColumns(s.mix) : null;
      if (songChanged || !same(mixNow, mixWas)) {
        Object.assign(u, mixNow ?? { song_start_sec: null, song_volume: null, video_volume: null });
      }
      if (!same(stickers, s.stickers)) {
        // The composer's rules (lib/stickerTiming). A post whose length was never
        // recorded has no window to time against, so its captions keep what they had.
        if (horizontal) {
          // Band captions, all in timed_captions, and the bubble per band that apps
          // before 1.0.3 draw (lib/bandCaptions).
          const band = winEnd > winStart ? timingForPublish(stickers, winStart, winEnd) : stickers;
          u.timed_captions = band.length ? band : null;
          u.top_caption = legacyBandCaption(band, 'top');
          u.bottom_caption = legacyBandCaption(band, 'bottom');
        } else {
          const { always, timed } = winEnd > winStart
            ? splitForPublish(stickers, winStart, winEnd)
            : { always: stickers.filter((k) => !isTimed(k)), timed: stickers.filter((k) => isTimed(k)) };
          u.captions = always.length ? always : null;
          u.timed_captions = timed.length ? timed : null;
        }
      }
      if (cover && cover !== s.cover) u.thumbnail_url = cover;
    }
    if (isAudio && cover && cover !== s.cover) u.cover_url = cover;
    if (wasScheduled && publishAt !== s.publishAt) u.publish_at = new Date(publishAt ?? Date.now()).toISOString();
    return u;
  }
  const dirty = !!snap && Object.keys(buildUpdate()).length > 0;

  // Leaving with unsaved edits asks first — the close button, a swipe back and
  // Android's back button alike.
  usePreventRemove(dirty && !leaving && !saving, ({ data }) => setConfirmLeave(data.action));
  useEffect(() => {
    if (!leaving) return;
    if (leaving.action) navigation.dispatch(leaving.action);
    else router.back();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  async function save() {
    if (saving || !row || !snap) return;
    const s = snap;
    const u = buildUpdate();
    if (!Object.keys(u).length) { setLeaving({}); return; }
    setError('');
    // The same objectionable-text gate as posting, over every piece of text an
    // edit can put on the post.
    const screened = await checkFields(caption, ...stickers.map((k) => k.text), isFilm ? filmTitle : null);
    if (!screened.ok) { setError(t('filter.blockedBody')); return; }

    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('signed out');

      // A cover from the camera roll goes up first; a frame from the video is
      // already a URL.
      for (const col of ['thumbnail_url', 'cover_url']) {
        const v = u[col];
        if (typeof v === 'string' && isLocalFile(v)) {
          try {
            u[col] = await uploadImage(user.id, v);
          } catch {
            setError(t('editPost.coverFailed'));
            setSaving(false);
            return;
          }
        }
      }

      const { data, error: updateError } = await supabase.from('posts').update(u).eq('id', id).select('id');
      if (updateError || !data?.length) {
        setError(t('editPost.notSaved'));
        setSaving(false);
        return;
      }

      // The people this edit newly involves, told once — only on a post already
      // live. A scheduled post is announced from its row when it goes up.
      if (!wasScheduled) {
        const me = user.id;
        const hadMention = new Set(extractMentionUsernames(s.caption));
        const added = extractMentionUsernames(caption).filter((name) => !hadMention.has(name));
        if (added.length) processMentions({ text: added.map((name) => `@${name}`).join(' '), actorId: me, postId: id });
        if (!isAudio) {
          const had = new Set(s.tagged.map((p) => p.id));
          for (const p of tagged) {
            if (!had.has(p.id) && p.id !== me) createNotification({ userId: p.id, actorId: me, type: 'tag', postId: id });
          }
          if (song && song.id !== s.song?.id && song.artistId && song.artistId !== me) {
            createNotification({ userId: song.artistId, actorId: me, type: 'song_used', postId: id });
          }
        } else {
          const had = new Set(s.features.map((f) => f.id).filter(Boolean));
          for (const f of features) {
            if (f.id && !had.has(f.id) && f.id !== me) createNotification({ userId: f.id, actorId: me, type: 'tag', postId: id });
          }
        }
      }
      if (wasScheduled && 'publish_at' in u) {
        if (publishAt != null && publishAt > Date.now()) scheduleLiveReminder(id, publishAt);
        else cancelLiveReminder(id);
      }

      emitPostEdited(id, u);
      notifySuccess();
      setLeaving({});
    } catch {
      setError(t('editPost.notSaved'));
      setSaving(false);
    }
  }

  async function pickAudioCover() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!res.canceled && res.assets?.[0]) setCover(res.assets[0].uri);
    } catch {
      // Cancelled or unavailable: the artwork stays.
    }
  }

  function keepStudio(r: StudioResult) {
    setStickers(r.captions);
    if (r.mix && song && !musicVideo) setMix({ ...r.mix, songId: song.id });
    setStudio(null);
  }

  const words = {
    today: t('schedule.today'),
    tomorrow: t('schedule.tomorrow'),
    dayTime: (day: string, time: string) => t('schedule.dayTime', { day, time }),
  };
  const selGenre = GENRES.find((g) => g.toLowerCase() === genre);

  if (!row || !snap) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerBtn}>
            <Ionicons name="close" size={24} color={colors.textSecondary} />
          </View>
          <Text style={styles.headerTitle}>{t('editPost.title')}</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.content}>
          <View style={styles.previewRow}>
            <Skeleton width={96} height={128} radius={RADIUS.md} />
            <View style={{ flex: 1, gap: 10 }}>
              <SkeletonLine w={120} h={14} />
              <SkeletonLine w="80%" h={11} />
              <Skeleton width={110} height={34} radius={RADIUS.full} />
            </View>
          </View>
          <Skeleton width="100%" height={110} radius={RADIUS.md} />
          {[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={56} radius={RADIUS.md} />)}
        </View>
      </View>
    );
  }

  const poster = cover ?? row.thumbnail_url ?? (row.media_url ? cfStreamThumbnail(row.media_url) : null);
  const pictureThumb = type === 'image'
    ? row.media_url
    : type === 'slideshow'
      ? (() => { const first = parseSlides(row)[0]; return first ? (first.thumbnail_url || first.url) : null; })()
      : null;
  const max = isAudio ? TITLE_MAX : CAPTION_MAX;
  const mentionQuery = isAudio ? null : getActiveMentionQuery(caption, cursor);
  const captionCount = stickers.length;

  const leaveDialog = (
    <ConfirmDialog
      visible={!!confirmLeave}
      icon="create-outline"
      title={t('editPost.discardTitle')}
      message={t('editPost.discardBody')}
      confirmLabel={t('editPost.discard')}
      cancelLabel={t('editPost.keepEditing')}
      destructive
      onConfirm={() => { const action = confirmLeave; setConfirmLeave(null); setLeaving({ action }); }}
      onCancel={() => setConfirmLeave(null)}
    />
  );

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} style={styles.headerBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('editPost.title')}</Text>
        <TouchableOpacity
          style={[styles.saveBtn, (!dirty || saving) && styles.saveBtnOff]}
          onPress={save}
          disabled={!dirty || saving}
          accessibilityRole="button"
        >
          {saving
            ? <ActivityIndicator color={colors.background} size="small" />
            : <Text style={styles.saveBtnText}>{t('common.save')}</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ── The media ─────────────────────────────────────────────────────── */}
        {isVideo && (
          <View style={styles.previewRow}>
            <TouchableOpacity
              style={styles.poster}
              onPress={() => setStudio('cover')}
              disabled={!videoReady}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('post.editCover')}
            >
              {poster
                ? <ExpoImage source={{ uri: poster }} style={StyleSheet.absoluteFill} contentFit="cover" />
                : <Ionicons name="videocam-outline" size={26} color={colors.textTertiary} />}
              {videoReady && (
                <View style={styles.posterTag} pointerEvents="none">
                  <Ionicons name="images-outline" size={11} color="#fff" />
                  <Text style={styles.posterTagText}>{t('post.editCover')}</Text>
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.previewText}>
              <Text style={styles.previewTitle}>{t('editPost.videoTitle')}</Text>
              <Text style={styles.previewSub}>{videoReady ? t('editPost.videoSub') : t('editPost.videoProcessing')}</Text>
              <View style={styles.chips}>
                {captionCount > 0 && (
                  <View style={styles.chip}>
                    <Ionicons name="text" size={12} color={colors.text} />
                    <Text style={styles.chipText}>{captionCount}</Text>
                  </View>
                )}
                {song && (
                  <View style={[styles.chip, styles.chipWide]}>
                    <Ionicons name="musical-notes" size={12} color={colors.primary} />
                    <Text style={styles.chipText} numberOfLines={1}>{song.title}</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity
                style={[styles.studioBtn, !videoReady && styles.studioBtnOff]}
                onPress={() => setStudio('open')}
                disabled={!videoReady}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                <Ionicons name="color-wand" size={15} color={colors.background} />
                <Text style={styles.studioBtnText}>{t('editPost.videoTitle')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {isPicture && !!pictureThumb && (
          <View style={styles.pictureWrap}>
            <ExpoImage source={{ uri: pictureThumb }} style={styles.picture} contentFit="cover" />
          </View>
        )}

        {isAudio && (
          <View style={styles.audioTop}>
            <TouchableOpacity style={styles.audioCover} onPress={pickAudioCover} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('post.coverArt')}>
              {cover
                ? <ExpoImage source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
                : <Ionicons name="image-outline" size={34} color={colors.textTertiary} />}
              <View style={styles.posterTag} pointerEvents="none">
                <Text style={styles.posterTagText}>{cover ? t('post.coverChangeHint') : t('post.addCoverArt')}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.kinds}>
              {AUDIO_KINDS.map(({ val, icon }) => {
                const on = audioKind === val;
                return (
                  <TouchableOpacity key={val} style={[styles.kind, on && styles.kindOn]} onPress={() => setAudioKind(val)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                    <Ionicons name={icon} size={15} color={on ? colors.background : colors.textSecondary} />
                    <Text style={[styles.kindText, on && styles.kindTextOn]}>{t(`post.cat.${val}`)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* ── Words ─────────────────────────────────────────────────────────── */}
        <View style={styles.field}>
          <Text style={styles.label}>{isAudio ? t('post.titleLabel') : t('editPost.caption')}</Text>
          <TextInput
            style={isAudio ? styles.titleInput : styles.captionInput}
            value={caption}
            onChangeText={setCaption}
            onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
            placeholder={isAudio ? t('post.titlePlaceholder') : t('post.captionPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            multiline={!isAudio}
            maxLength={max}
          />
          <Text style={[styles.counter, caption.length >= max * 0.9 && { color: colors.error }]}>{caption.length}/{max}</Text>
          {!isAudio && (
            <MentionSuggestions
              query={mentionQuery}
              onPick={(u) => { const r = applyMention(caption, cursor, u); setCaption(r.text); setCursor(r.cursor); }}
            />
          )}
        </View>

        {isFilm && (
          <View style={styles.field}>
            <Text style={styles.label}>{t('film.titleLabel')}</Text>
            <TextInput
              style={styles.titleInput}
              value={filmTitle}
              onChangeText={setFilmTitle}
              placeholder={t('film.titlePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              maxLength={120}
            />
          </View>
        )}

        {/* ── Who and what ──────────────────────────────────────────────────── */}
        <View style={styles.card}>
          {!isAudio && (
            <Row
              icon="person-add-outline"
              label={t('post.tagPeople')}
              value={tagged.length ? tagged.map((p) => `@${p.username}`).join(', ') : ''}
              placeholder="—"
              onPress={() => setShowTags(true)}
              styles={styles}
              colors={colors}
            />
          )}
          {isAudio && (
            <Row
              icon="people-outline"
              label={t('features.title')}
              value={features.map((f) => f.name).join(', ')}
              placeholder={t('features.add')}
              onPress={() => setShowFeatures(true)}
              styles={styles}
              colors={colors}
            />
          )}
          {isPicture && (
            <Row
              icon="musical-notes-outline"
              label={t('post.musicLabel')}
              value={song ? song.title : ''}
              placeholder={t('post.addMusic')}
              accent={!!song}
              onPress={() => setShowSongs(true)}
              onClear={song ? () => setSong(null) : undefined}
              clearLabel={t('a11y.clear')}
              styles={styles}
              colors={colors}
            />
          )}
          {(!isAudio || audioKind === 'audio') && (
            <Row
              icon="pricetag-outline"
              label={t('post.genre')}
              value={selGenre ? genreLabel(selGenre) : ''}
              placeholder={hasCommunity ? t('post.noGenre') : t('post.selectGenre')}
              sub={hasCommunity ? t('post.genreFromCommunity') : undefined}
              locked={hasCommunity}
              onPress={() => setShowGenres(true)}
              styles={styles}
              colors={colors}
            />
          )}
          <Row
            icon={hasCommunity || isPublic ? 'globe-outline' : 'people-outline'}
            label={hasCommunity || isPublic ? t('post.public') : t('post.friendsOnly')}
            value={hasCommunity ? t('post.communityPublicLock') : isPublic ? t('post.publicSub') : t('post.friendsOnlySub')}
            placeholder=""
            locked={hasCommunity}
            trailing="swap-horizontal"
            onPress={() => setIsPublic((v) => !v)}
            styles={styles}
            colors={colors}
            last={!wasScheduled}
          />
          {wasScheduled && (
            <Row
              icon={publishAt != null ? 'calendar' : 'rocket-outline'}
              label={t('schedule.row')}
              value={publishAt != null ? formatSchedule(publishAt, Date.now(), lang, words) : t('schedule.now')}
              placeholder=""
              accent
              onPress={() => setShowSchedule(true)}
              styles={styles}
              colors={colors}
              last
            />
          )}
        </View>

        {/* ── Settings ──────────────────────────────────────────────────────── */}
        <View style={styles.card}>
          {isAudio && (
            <Toggle label={t('offline.downloadableLabel')} value={downloadable} onChange={setDownloadable} styles={styles} colors={colors} />
          )}
          {isVideo && (
            <Toggle label={t('post.allowGifsLabel')} value={allowGifs} onChange={setAllowGifs} styles={styles} colors={colors} />
          )}
          <Toggle label={t('post.matureLabel')} value={mature} onChange={setMature} styles={styles} colors={colors} last />
        </View>

        {!!error && (
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      <TagPeopleModal visible={showTags} initial={tagged} onClose={() => setShowTags(false)} onDone={setTagged} />
      <SongPickerModal visible={showSongs} onClose={() => setShowSongs(false)} onSelect={setSong} />
      <FeaturesModal visible={showFeatures} initial={features} onClose={() => setShowFeatures(false)} onDone={setFeatures} />
      <SchedulePicker
        visible={showSchedule}
        value={publishAt}
        onClose={() => setShowSchedule(false)}
        onSet={(at) => { setPublishAt(at); setShowSchedule(false); }}
        onClear={() => { setPublishAt(null); setShowSchedule(false); }}
      />

      <SlideUpSheet visible={showGenres} onClose={() => setShowGenres(false)} sheetStyle={styles.sheet}>
        <Text style={styles.sheetTitle}>{t('post.pickGenre')}</Text>
        <View style={styles.genres}>
          <TouchableOpacity style={[styles.genreChip, !genre && styles.genreChipOn]} onPress={() => { setGenre(''); setShowGenres(false); }}>
            <Text style={[styles.genreText, !genre && styles.genreTextOn]}>{t('post.noGenre')}</Text>
          </TouchableOpacity>
          {GENRES.map((g) => {
            const on = genre === g.toLowerCase();
            return (
              <TouchableOpacity key={g} style={[styles.genreChip, on && styles.genreChipOn]} onPress={() => { setGenre(g.toLowerCase()); setShowGenres(false); }}>
                <Text style={[styles.genreText, on && styles.genreTextOn]}>{genreLabel(g)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </SlideUpSheet>

      {studio && videoReady && (
        <VideoStudio
          videoUri={row.media_url}
          posterUri={poster}
          aspect={aspect}
          windowStart={winStart}
          windowEnd={winEnd}
          initialCaptions={stickers}
          song={song}
          onSong={setSong}
          musicVideo={musicVideo}
          onMusicVideo={setMusicVideo}
          songMix={song && mix && mix.songId === song.id ? { startSec: mix.startSec, songVolume: mix.songVolume, videoVolume: mix.videoVolume } : null}
          coverUri={cover}
          onCover={setCover}
          coverSec={coverSec}
          onCoverSec={setCoverSec}
          initialPanel={studio === 'cover' ? 'cover' : null}
          nextLabel={t('common.done')}
          nextIcon="checkmark"
          onBack={keepStudio}
          onNext={keepStudio}
        />
      )}

      {Platform.OS === 'ios' ? <FullWindowOverlay>{leaveDialog}</FullWindowOverlay> : leaveDialog}
    </KeyboardAvoidingView>
  );
}

// One settings row: an icon, a label over its value, and a chevron, a lock or a
// clear button.
function Row({
  icon, label, value, placeholder, sub, onPress, locked, onClear, clearLabel, accent, trailing, last, styles, colors,
}: {
  icon: IconName;
  label: string;
  value: string;
  placeholder: string;
  sub?: string;
  onPress: () => void;
  locked?: boolean;
  onClear?: () => void;
  clearLabel?: string;
  accent?: boolean;
  trailing?: IconName;
  last?: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemePalette;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, !last && styles.rowDivider]}
      onPress={onPress}
      disabled={locked}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!locked }}
    >
      <Ionicons name={icon} size={20} color={accent ? colors.primary : colors.text} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, !value && styles.rowPlaceholder, accent && !!value && { color: colors.primary }]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {onClear ? (
        <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={clearLabel}>
          <Ionicons name="close-circle" size={19} color={colors.textTertiary} />
        </TouchableOpacity>
      ) : (
        <Ionicons name={locked ? 'lock-closed' : trailing ?? 'chevron-forward'} size={17} color={colors.textTertiary} />
      )}
    </TouchableOpacity>
  );
}

function Toggle({ label, value, onChange, last, styles, colors }: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemePalette;
}) {
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <Text style={[styles.rowLabel, { flex: 1 }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.text, false: colors.surfaceLight }}
        thumbColor={value ? colors.background : '#fff'}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  headerBtn: { padding: SPACING.sm, width: 72 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  saveBtn: {
    minWidth: 72, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: 8, borderRadius: RADIUS.full, backgroundColor: colors.primary,
  },
  saveBtnOff: { opacity: 0.4 },
  saveBtnText: { color: colors.background, fontSize: 15, fontWeight: '800' },

  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl * 2 },

  previewRow: { flexDirection: 'row', gap: SPACING.md },
  poster: {
    width: 96, height: 128, borderRadius: RADIUS.md, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },
  posterTag: {
    position: 'absolute', left: 6, right: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 4, borderRadius: RADIUS.full, backgroundColor: 'rgba(0,0,0,0.55)',
  },
  posterTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  previewText: { flex: 1, gap: 6, justifyContent: 'center' },
  previewTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  previewSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
  },
  chipWide: { maxWidth: '100%' },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  studioBtn: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: RADIUS.full, backgroundColor: colors.text,
  },
  studioBtnOff: { opacity: 0.4 },
  studioBtnText: { color: colors.background, fontSize: 14, fontWeight: '800' },

  pictureWrap: { alignItems: 'center' },
  picture: { width: 140, height: 140, borderRadius: RADIUS.lg, backgroundColor: colors.surfaceLight },

  audioTop: { alignItems: 'center', gap: SPACING.md },
  audioCover: {
    width: 180, height: 180, borderRadius: RADIUS.lg, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },
  kinds: { flexDirection: 'row', gap: SPACING.sm, alignSelf: 'stretch' },
  kind: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight,
  },
  kindOn: { backgroundColor: colors.text },
  kindText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  kindTextOn: { color: colors.background },

  field: { gap: 6 },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  captionInput: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.md,
    color: colors.text, fontSize: 15, minHeight: 104, textAlignVertical: 'top',
  },
  titleInput: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: 12,
    color: colors.text, fontSize: 15,
  },
  counter: { alignSelf: 'flex-end', color: colors.textTertiary, fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },

  card: { borderRadius: RADIUS.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: SPACING.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: 13 },
  rowDivider: { borderBottomWidth: 0.5, borderBottomColor: colors.border },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowValue: { color: colors.textSecondary, fontSize: 13 },
  rowPlaceholder: { color: colors.textTertiary },
  rowSub: { color: colors.textTertiary, fontSize: 12 },

  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { color: colors.error, fontSize: 13, fontWeight: '600', flexShrink: 1 },

  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.lg, paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  genres: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, justifyContent: 'center' },
  genreChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight },
  genreChipOn: { backgroundColor: colors.text },
  genreText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  genreTextOn: { color: colors.background, fontWeight: '800' },
});
