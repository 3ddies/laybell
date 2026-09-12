import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, Platform,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useFocusEffect, useRouter } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { deletePostById } from '../lib/postActions';
import { isAudioPost } from '../lib/genres';
import { cfStreamThumbnail } from '../lib/cast';
import { formatSchedule } from '../lib/schedule';
import { cancelLiveReminder, scheduleLiveReminder } from '../lib/scheduleNotify';
import { notifySuccess } from '../lib/haptics';
import SchedulePicker from '../components/SchedulePicker';
import ConfirmDialog from '../components/ConfirmDialog';
import Toast from '../components/Toast';
import { CardsSkeleton } from '../components/Skeleton';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Posts waiting to go live, soonest first. Each can go up now, move to another
// time, be edited, or be deleted before anyone sees it. The waiting itself is the
// server's (supabase/sql/post_scheduling.sql): nothing here has to stay open for a
// post to go live on time.

type Scheduled = {
  id: string;
  type: string;
  caption: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  cover_url: string | null;
  publish_at: string;
  is_public: boolean;
  video_status: string | null;
};

export default function ScheduledScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, lang } = useTranslation();
  const router = useRouter();
  const [posts, setPosts] = useState<Scheduled[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [moving, setMoving] = useState<Scheduled | null>(null);
  const [deleting, setDeleting] = useState<Scheduled | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const when = (iso: string) => formatSchedule(new Date(iso).getTime(), Date.now(), lang, {
    today: t('schedule.today'),
    tomorrow: t('schedule.tomorrow'),
    dayTime: (day: string, time: string) => t('schedule.dayTime', { day, time }),
  });

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }
    const { data } = await supabase
      .from('posts')
      .select('id, type, caption, media_url, thumbnail_url, cover_url, publish_at, is_public, video_status')
      .eq('user_id', user.id)
      // Still waiting. One whose minute has come is already live for everyone.
      .gt('publish_at', new Date().toISOString())
      // An archived one waits in the archive instead (the publisher skips it too).
      .is('archived_at', null)
      .order('publish_at', { ascending: true });
    setPosts((data as Scheduled[] | null) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Back from editing one, or from the composer with a new one.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function postNow(p: Scheduled) {
    // Visible the moment publish_at passes; the publisher sends its notifications
    // within the minute.
    const { data, error } = await supabase
      .from('posts')
      .update({ publish_at: new Date().toISOString() })
      .eq('id', p.id)
      .select('id');
    if (error || !data?.length) { setToast(t('schedule.failed')); return; }
    cancelLiveReminder(p.id);
    notifySuccess();
    setPosts((list) => list.filter((x) => x.id !== p.id));
    setToast(t('schedule.postedNow'));
  }

  async function moveTo(p: Scheduled, at: number) {
    setMoving(null);
    const iso = new Date(at).toISOString();
    const { data, error } = await supabase
      .from('posts')
      .update({ publish_at: iso })
      .eq('id', p.id)
      .select('id');
    if (error || !data?.length) { setToast(t('schedule.failed')); return; }
    scheduleLiveReminder(p.id, at);
    setPosts((list) => list
      .map((x) => (x.id === p.id ? { ...x, publish_at: iso } : x))
      .sort((a, b) => a.publish_at.localeCompare(b.publish_at)));
    setToast(t('schedule.moved', { when: when(iso) }));
  }

  async function doDelete() {
    const p = deleting;
    setDeleting(null);
    if (!p) return;
    const ok = await deletePostById(p.id);
    if (!ok) { setToast(t('schedule.failed')); return; }
    cancelLiveReminder(p.id);
    setPosts((list) => list.filter((x) => x.id !== p.id));
  }

  const thumbOf = (p: Scheduled) =>
    p.thumbnail_url || p.cover_url || (p.type === 'image' ? p.media_url : null) || (p.media_url ? cfStreamThumbnail(p.media_url) : null);

  const dialog = (
    <ConfirmDialog
      visible={!!deleting}
      icon="trash-outline"
      title={t('schedule.deleteTitle')}
      message={t('schedule.deleteBody')}
      confirmLabel={t('schedule.delete')}
      accentColor={colors.error}
      onConfirm={doDelete}
      onCancel={() => setDeleting(null)}
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('schedule.screenTitle')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.skeleton}><CardsSkeleton /></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        >
          <Text style={styles.hint}>{t('schedule.hint')}</Text>
          {posts.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="calendar-outline" size={44} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>{t('schedule.empty')}</Text>
            </View>
          ) : posts.map((p) => {
            const thumb = thumbOf(p);
            return (
              <View key={p.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={styles.thumb}>
                    {thumb ? (
                      <ExpoImage source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
                    ) : (
                      <Ionicons name={isAudioPost(p.type) ? 'musical-notes' : 'image-outline'} size={22} color={colors.textTertiary} />
                    )}
                  </View>
                  <View style={styles.cardText}>
                    <View style={styles.whenRow}>
                      <Ionicons name="time-outline" size={14} color={colors.primary} />
                      <Text style={styles.when} numberOfLines={1}>{when(p.publish_at)}</Text>
                    </View>
                    <Text style={styles.caption} numberOfLines={2}>{p.caption?.trim() || '—'}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {p.is_public ? t('post.public') : t('post.friendsOnly')}
                      {p.type === 'video' && p.video_status === 'processing' ? ` · ${t('schedule.processing')}` : ''}
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <Action icon="rocket-outline" label={t('schedule.postNow')} onPress={() => postNow(p)} styles={styles} color={colors.primary} />
                  <Action icon="calendar-outline" label={t('schedule.changeTime')} onPress={() => setMoving(p)} styles={styles} color={colors.text} />
                  <Action icon="create-outline" label={t('schedule.edit')} onPress={() => router.push(`/edit-post/${p.id}`)} styles={styles} color={colors.text} />
                  <Action icon="trash-outline" label={t('schedule.delete')} onPress={() => setDeleting(p)} styles={styles} color={colors.error} />
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <SchedulePicker
        visible={!!moving}
        value={moving ? new Date(moving.publish_at).getTime() : null}
        onClose={() => setMoving(null)}
        onSet={(at) => { if (moving) moveTo(moving, at); }}
      />
      <Toast visible={!!toast} icon="checkmark-circle" title={toast ?? ''} onHide={() => setToast(null)} />
      {Platform.OS === 'ios' ? <FullWindowOverlay>{dialog}</FullWindowOverlay> : dialog}
    </View>
  );
}

function Action({ icon, label, onPress, styles, color }: {
  icon: 'rocket-outline' | 'calendar-outline' | 'create-outline' | 'trash-outline';
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  color: string;
}) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel={label}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.actionText, { color }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  skeleton: { padding: SPACING.md },
  scroll: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl, flexGrow: 1 },
  hint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  empty: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.sm },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface, borderRadius: RADIUS.lg, padding: SPACING.md, gap: SPACING.md,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTop: { flexDirection: 'row', gap: SPACING.md },
  thumb: {
    width: 64, height: 64, borderRadius: RADIUS.md, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },
  cardText: { flex: 1, gap: 3 },
  whenRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  when: { color: colors.primary, fontSize: 13, fontWeight: '800', flexShrink: 1 },
  caption: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  meta: { color: colors.textTertiary, fontSize: 12 },
  actions: {
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 0.5, borderTopColor: colors.border, paddingTop: SPACING.sm,
  },
  action: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 2 },
  actionText: { fontSize: 11, fontWeight: '700' },
});
