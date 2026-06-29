import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { rawTier } from '../lib/badges';
import {
  TEMPLATE_META, TEMPLATE_ORDER, templateUnlock, countMedia, emptyBlock, blockComplete,
  isVisualPost, isSongPost, isLoopMedia, parseBlocks, isLayoutTemplate,
  type LayoutTemplate, type BlockKind,
} from '../lib/pageLayout';
import ProfileLayoutGrid from '../components/ProfileLayoutGrid';
import LayoutSlotPicker from '../components/LayoutSlotPicker';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Skeleton, SkeletonLine } from '../components/Skeleton';

type PickerState = { blockIndex: number; field: string; subIndex?: number } | null;

export default function PageLayoutScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { profile, update } = useProfile();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [posts, setPosts] = useState<any[]>([]);
  const [template, setTemplate] = useState<LayoutTemplate | null>(null);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [picker, setPicker] = useState<PickerState>(null);
  const [saving, setSaving] = useState(false);

  const tier = rawTier(profile);
  const counts = countMedia(posts);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      // The layout rearranges the PUBLIC Posts grid, so slots draw from the same
      // set the grid shows: the user's public, non-archived posts.
      const { data } = await supabase
        .from('posts').select('*')
        .eq('user_id', user.id).eq('is_public', true)
        .order('created_at', { ascending: false });
      const visible = (data ?? []).filter((p: any) => !p.archived_at);
      setPosts(visible);

      // Preload a saved layout — but only if the user still qualifies for it
      // (otherwise it's hidden on their profile anyway; they can re-pick it).
      const saved = profile?.page_layout;
      if (isLayoutTemplate(saved)) {
        const u = templateUnlock(saved, rawTier(profile), countMedia(visible));
        if (u.tierOk) {
          const savedBlocks = parseBlocks(profile?.layout_blocks);
          if (savedBlocks.length) { setTemplate(saved); setBlocks(savedBlocks); }
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTemplate(t: LayoutTemplate) {
    if (t === template) return;
    setTemplate(t);
    // Seed a fresh, empty first block to build into.
    setBlocks([emptyBlock(t === 'big_picture' ? 'big_picture' : 'media_star')]);
  }

  function addBlock(kind: BlockKind) {
    setBlocks(prev => [...prev, emptyBlock(kind)]);
  }
  function removeBlock(i: number) {
    setBlocks(prev => {
      const next = prev.filter((_, idx) => idx !== i);
      // Always keep at least one block to build into (esp. single-block templates
      // like Big Picture, which have no "add" button to recreate one).
      if (next.length === 0 && template) return [emptyBlock(template === 'big_picture' ? 'big_picture' : 'media_star')];
      return next;
    });
  }
  function toggleLoop(i: number) {
    setBlocks(prev => prev.map((b, idx) =>
      idx === i ? { ...b, loop: !b.loop } : { ...b, loop: false }, // only one loop per profile
    ));
  }

  // ── Slot assignment ──
  function eligibleFor(field: string) {
    if (field === 'song') return isSongPost;
    if (field === 'regular') return (p: any) => isVisualPost(p) || isSongPost(p);
    return isVisualPost; // main, big
  }
  function allUsedIds(): Set<string> {
    const s = new Set<string>();
    for (const b of blocks) {
      if (b.kind === 'media_star') { if (b.main) s.add(b.main); (b.songs || []).forEach((id: string) => id && s.add(id)); }
      else { if (b.big) s.add(b.big); (b.regulars || []).forEach((id: string) => id && s.add(id)); }
    }
    return s;
  }
  function currentSlotValue(p: PickerState): string | null {
    if (!p) return null;
    const b = blocks[p.blockIndex];
    if (!b) return null;
    if (p.field === 'main') return b.main ?? null;
    if (p.field === 'big') return b.big ?? null;
    if (p.field === 'song') return b.songs?.[p.subIndex ?? 0] ?? null;
    if (p.field === 'regular') return b.regulars?.[p.subIndex ?? 0] ?? null;
    return null;
  }
  function assignPost(post: any) {
    if (!picker) return;
    const { blockIndex, field, subIndex } = picker;
    setBlocks(prev => prev.map((b, idx) => {
      if (idx !== blockIndex) return b;
      if (field === 'main') return { ...b, main: post.id };
      if (field === 'big') return { ...b, big: post.id };
      if (field === 'song') { const songs = [...(b.songs || [null, null])]; songs[subIndex ?? 0] = post.id; return { ...b, songs }; }
      if (field === 'regular') { const regs = [...(b.regulars || [null, null])]; regs[subIndex ?? 0] = post.id; return { ...b, regulars: regs }; }
      return b;
    }));
    setPicker(null);
  }

  // Eligible posts for the open picker (right type, not used in another slot).
  const pickerPosts = (() => {
    if (!picker) return [];
    const match = eligibleFor(picker.field);
    const used = allUsedIds();
    const current = currentSlotValue(picker);
    if (current) used.delete(current);
    return posts.filter(p => match(p) && !used.has(p.id));
  })();

  const completeCount = blocks.filter(blockComplete).length;
  const canSave = !!template && completeCount >= 1;
  const hasActiveSaved = isLayoutTemplate(profile?.page_layout) && parseBlocks(profile?.layout_blocks).length > 0;

  async function handleSave() {
    if (!template) return;
    const complete = blocks.filter(blockComplete);
    if (!complete.length) { Alert.alert(t('pageLayout.incompleteTitle'), t('pageLayout.incompleteBody')); return; }
    setSaving(true);
    const byId = new Map(posts.map(p => [p.id, p]));
    const clean = complete.map((b) => {
      if (b.kind === 'media_star') return { kind: 'media_star', main: b.main, songs: [b.songs[0], b.songs[1]] };
      // Loop is Diamond-only (Big Bell) AND only valid on a video or slideshow
      // hero (video → muted 12s loop; slideshow → 2s auto-advancing slides).
      const loop = template === 'big_bell' && !!b.loop && isLoopMedia(byId.get(b.big));
      return { kind: 'big_picture', big: b.big, regulars: [b.regulars[0], b.regulars[1]], loop };
    });
    // Guarantee at most one loop survives.
    let loopSeen = false;
    for (const b of clean as any[]) {
      if (b.kind === 'big_picture' && b.loop) { if (loopSeen) b.loop = false; else loopSeen = true; }
    }
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('profiles').update({ page_layout: template, layout_blocks: clean }).eq('id', user!.id);
    setSaving(false);
    if (error) { Alert.alert(t('pageLayout.saveErrorTitle'), error.message); return; }
    update({ page_layout: template, layout_blocks: clean });
    Alert.alert(t('pageLayout.savedTitle'), t('pageLayout.savedBody'), [{ text: t('pageLayout.ok'), onPress: () => router.back() }]);
  }

  async function handleReset() {
    Alert.alert(t('pageLayout.resetTitle'), t('pageLayout.resetBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('pageLayout.resetConfirm'), style: 'destructive', onPress: async () => {
          setSaving(true);
          const { data: { user } } = await supabase.auth.getUser();
          await supabase.from('profiles').update({ page_layout: 'default', layout_blocks: [] }).eq('id', user!.id);
          update({ page_layout: 'default', layout_blocks: [] });
          setSaving(false);
          setTemplate(null); setBlocks([]);
          router.back();
        },
      },
    ]);
  }

  function openPicker(blockIndex: number, field: string, subIndex?: number) {
    setPicker({ blockIndex, field, subIndex });
  }

  const pickerTitle = picker
    ? picker.field === 'song' ? t('pageLayout.pickSong')
      : picker.field === 'regular' ? t('pageLayout.pickAny')
        : picker.field === 'big' ? t('pageLayout.pickHero')
          : t('pageLayout.pickPhotoVideo')
    : '';

  if (loading) {
    return (
      <View style={styles.container}>
        {/* Header (matches the loaded layout so nothing jumps) */}
        <View style={styles.header}>
          <SkeletonLine w={52} h={15} />
          <SkeletonLine w={110} h={18} />
          <SkeletonLine w={42} h={15} />
        </View>

        <View style={styles.body}>
          {/* Intro line */}
          <SkeletonLine w={'92%'} h={13.5} />
          {/* Counts row */}
          <View style={styles.countsRow}>
            <SkeletonLine w={90} h={14} />
            <SkeletonLine w={70} h={14} />
          </View>
          {/* Section label */}
          <SkeletonLine w={88} h={11} style={{ marginTop: SPACING.sm }} />
          {/* Template-card rows */}
          <View style={styles.templateList}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.tplCard}>
                <Skeleton width={44} height={44} radius={RADIUS.md} />
                <View style={{ flex: 1, gap: 8 }}>
                  <SkeletonLine w={'55%'} h={16} />
                  <SkeletonLine w={'85%'} h={12.5} />
                </View>
              </View>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}><Text style={styles.cancel}>{t('common.cancel')}</Text></TouchableOpacity>
        <Text style={styles.headerTitle}>{t('editProfile.pageLayout')}</Text>
        <TouchableOpacity onPress={handleSave} disabled={!canSave || saving}>
          {saving ? <ActivityIndicator color={colors.primary} size="small" /> : <Text style={[styles.save, !canSave && styles.saveOff]}>{t('editProfile.save')}</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          {t('pageLayout.introPre')}<Text style={{ fontWeight: '800', color: colors.text }}>{t('pageLayout.postsWord')}</Text>{t('pageLayout.introPost')}
        </Text>
        <View style={styles.countsRow}>
          <Counts icon="image" n={counts.visual} label={t('pageLayout.photosVideos')} colors={colors} />
          <Counts icon="musical-notes" n={counts.audio} label={t('pageLayout.songs')} colors={colors} />
        </View>

        {/* Template picker */}
        <Text style={styles.sectionLabel}>{t('pageLayout.templateLabel')}</Text>
        <View style={styles.templateList}>
          {TEMPLATE_ORDER.map((tpl) => {
            const meta = TEMPLATE_META[tpl];
            const unlock = templateUnlock(tpl, tier, counts);
            const active = template === tpl;
            return (
              <TouchableOpacity
                key={tpl}
                activeOpacity={0.85}
                disabled={!unlock.unlocked}
                onPress={() => selectTemplate(tpl)}
                style={[styles.tplCard, active && styles.tplCardActive, !unlock.unlocked && styles.tplCardLocked]}
              >
                <View style={[styles.tplIcon, active && { backgroundColor: colors.primary }]}>
                  <Ionicons name={(unlock.unlocked ? meta.icon : 'lock-closed') as any} size={20} color={active ? '#fff' : unlock.unlocked ? colors.primary : colors.textTertiary} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.tplTitleRow}>
                    <Text style={[styles.tplTitle, !unlock.unlocked && { color: colors.textSecondary }]}>{meta.label}</Text>
                    <View style={[styles.tierPill, { borderColor: colors.primary + '55' }]}>
                      <Text style={styles.tierPillText}>{meta.minTier.toUpperCase()}</Text>
                    </View>
                  </View>
                  <Text style={styles.tplTagline}>{meta.tagline}</Text>
                  {!unlock.unlocked && unlock.reason && (
                    <Text style={styles.tplLockReason}><Ionicons name="lock-closed" size={10} color={colors.textTertiary} /> {unlock.reason}</Text>
                  )}
                </View>
                {active && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Builder */}
        {template && (
          <>
            <Text style={styles.sectionLabel}>{t('pageLayout.buildLabel')}</Text>
            <Text style={styles.builderHint}>{t('pageLayout.builderHint')} {TEMPLATE_META[template].multi ? t('pageLayout.builderHintMulti') : t('pageLayout.builderHintSingle')}</Text>

            <View style={styles.preview}>
              <ProfileLayoutGrid
                layout={{ template, blocks } as any}
                posts={posts}
                ownerTier={tier}
                editable
                onSlotPress={openPicker}
                onRemoveBlock={removeBlock}
                onToggleLoop={TEMPLATE_META[template].loop ? toggleLoop : undefined}
              />
            </View>

            {/* Add-block controls */}
            {TEMPLATE_META[template].multi && (
              <View style={styles.addRow}>
                {TEMPLATE_META[template].kinds.map((k) => (
                  <TouchableOpacity key={k} style={styles.addBtn} onPress={() => addBlock(k)}>
                    <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                    <Text style={styles.addText}>{t('pageLayout.addBlock', { name: k === 'media_star' ? TEMPLATE_META.media_star.label : TEMPLATE_META.big_picture.label })}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <Text style={styles.footNote}>
              {completeCount > 0
                ? t(completeCount === 1 ? 'pageLayout.footNoteOne' : 'pageLayout.footNoteMany', { n: completeCount })
                : t('pageLayout.footNoteEmpty')}
            </Text>
          </>
        )}

        {(hasActiveSaved || template) && (
          <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
            <Ionicons name="grid-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.resetText}>{t('pageLayout.resetToGrid')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <LayoutSlotPicker
        visible={!!picker}
        title={pickerTitle}
        subtitle={picker?.field === 'regular' ? t('pageLayout.pickAnySub') : undefined}
        posts={pickerPosts}
        selectedId={currentSlotValue(picker)}
        onPick={assignPost}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

function Counts({ icon, n, label, colors }: { icon: string; n: number; label: string; colors: ThemePalette }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Ionicons name={icon as any} size={14} color={colors.primary} />
      <Text style={{ color: colors.textSecondary, fontSize: 13 }}><Text style={{ color: colors.text, fontWeight: '800' }}>{n}</Text> {label}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  cancel: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  save: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  saveOff: { color: colors.textTertiary },

  body: { padding: SPACING.md, paddingBottom: SPACING.xxl + 40, gap: SPACING.md },
  intro: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 20 },
  countsRow: { flexDirection: 'row', gap: SPACING.lg, paddingVertical: SPACING.xs },

  sectionLabel: { color: colors.textTertiary, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginTop: SPACING.sm },

  templateList: { gap: SPACING.sm },
  tplCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border,
    padding: SPACING.md,
  },
  tplCardActive: { borderColor: colors.primary, backgroundColor: colors.primary + '12' },
  tplCardLocked: { opacity: 0.7 },
  tplIcon: {
    width: 44, height: 44, borderRadius: RADIUS.md, backgroundColor: colors.primary + '1A',
    alignItems: 'center', justifyContent: 'center',
  },
  tplTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  tplTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  tierPill: { borderWidth: 1, borderRadius: RADIUS.full, paddingHorizontal: 7, paddingVertical: 1 },
  tierPillText: { color: colors.primaryLight, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  tplTagline: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  tplLockReason: { color: colors.textTertiary, fontSize: 11.5, marginTop: 4, fontWeight: '600' },

  builderHint: { color: colors.textTertiary, fontSize: 12.5, lineHeight: 18 },
  preview: {
    borderRadius: RADIUS.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.background,
  },
  addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.primary + '44', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, backgroundColor: colors.primary + '10',
  },
  addText: { color: colors.primaryLight, fontSize: 13, fontWeight: '700' },
  footNote: { color: colors.textTertiary, fontSize: 12, lineHeight: 17 },

  resetBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: SPACING.md, paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  resetText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
});
