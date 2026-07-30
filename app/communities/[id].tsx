import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, Pressable, Image, Alert,
  Animated, Dimensions, Easing, Share, Platform, PanResponder,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { reportCommunity } from '../../lib/postActions';
import { communityShareUrl } from '../../lib/appLinks';
import { LinearGradient } from 'expo-linear-gradient';
import SwipeBackPager from '../../components/SwipeBackPager';
import ExploreGrid from '../../components/ExploreGrid';
import { Skeleton, SkeletonLine, GridSkeleton } from '../../components/Skeleton';
import CommunityMembersModal from '../../components/CommunityMembersModal';
import RoleBadge from '../../components/RoleBadge';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { genreLabel } from '../../lib/genres';
import { formatCount } from '../../lib/format';
import {
  fetchCommunity, fetchCommunityPosts, joinCommunity, leaveCommunity,
  respondInvite, type Community,
} from '../../lib/communities';

// Deterministic accent (matches CommunityCard) so the banner is stable per name.
const ACCENTS: readonly (readonly [string, string])[] = [
  ['#E8401C', '#F26522'], ['#7C3AED', '#A855F7'], ['#0EA5E9', '#22D3EE'],
  ['#F59E0B', '#FBBF24'], ['#10B981', '#34D399'], ['#EC4899', '#F472B6'],
  ['#6366F1', '#818CF8'], ['#EF4444', '#F87171'],
];
function accentFor(seed: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

const SCREEN_W = Dimensions.get('window').width;

export default function CommunityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // success green (#22C55E) is tuned for dark bg — on white the "Joined" pill
  // reads low-contrast, so use a darker green in light mode.
  const joinedColor = mode === 'light' ? '#15803D' : colors.success;
  const router = useRouter();
  const { profile } = useProfile();
  const userId = profile?.id ?? null;

  // Own right-to-left slide-in on mount (immediately, while it still loads) — the
  // pager's programmatic entrance can land instantly, so drive the entrance here
  // and let SwipeBackPager handle only the swipe-back (animateIn={false}).
  const entryX = useRef(new Animated.Value(SCREEN_W)).current;
  useEffect(() => {
    Animated.timing(entryX, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [entryX]);

  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([fetchCommunity(id, userId), fetchCommunityPosts(id)]);
    setCommunity(c);
    setPosts(p);
    setLoading(false);
  }, [id, userId]);

  useEffect(() => { load(); }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const role = community?.myRole ?? null;
  const myStatus = community?.myStatus ?? null;
  const isMember = myStatus === 'active';
  const canManage = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';

  async function onJoin() {
    setBusy(true);
    const ok = await joinCommunity(id);
    setBusy(false);
    if (ok) load();
    else Alert.alert(t('communities.title'), t('communities.errGeneric'));
  }

  async function onInvite(accept: boolean) {
    setBusy(true);
    await respondInvite(id, accept);
    setBusy(false);
    if (accept) load();
    else router.back();
  }

  function confirmLeave() {
    setMenuOpen(false);
    Alert.alert(
      t('communities.leaveTitle'),
      role === 'owner' ? t('communities.leaveOwnerBody') : t('communities.leaveBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('communities.leave'),
          style: 'destructive',
          onPress: async () => { await leaveCommunity(id); router.back(); },
        },
      ],
    );
  }

  // One body for every state (loading / not-found / content), wrapped once by the
  // pager + entrance Animated.View below — so the screen slides in showing the
  // skeleton, then the content fills in place (instead of popping in).
  let body: ReactNode;
  if (loading) {
    body = (
      <View style={styles.container}>
        <View style={styles.skelHeader}>
          <Skeleton width="100%" height={120} radius={0} style={styles.skelBanner} />
          <View style={styles.skelInfo}>
            <View style={styles.titleRow}>
              <View style={styles.titleCol}>
                <SkeletonLine w="70%" h={28} />
                <SkeletonLine w="40%" h={13} style={{ marginTop: 8 }} />
              </View>
              <Skeleton width={92} height={40} radius={RADIUS.full} />
            </View>
            <View style={{ marginTop: SPACING.sm }}>
              <SkeletonLine w="55%" h={13} />
            </View>
            <View style={styles.divider} />
            <View style={styles.rulesBlock}>
              <SkeletonLine w="30%" h={16} />
              <SkeletonLine w="100%" h={14} style={{ marginTop: 4 }} />
              <SkeletonLine w="80%" h={14} style={{ marginTop: 4 }} />
            </View>
            <View style={styles.divider} />
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <GridSkeleton columns={3} count={12} />
        </View>
      </View>
    );
  } else if (!community) {
    body = (
      <View style={styles.container}>
        <TopBar title={t('communities.title')} onBack={() => router.back()} />
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={44} color={colors.textTertiary} />
          <Text style={styles.notFound}>{t('communities.errNotLive')}</Text>
        </View>
      </View>
    );
  } else {
    body = renderContent();
  }

  return (
    <SwipeBackPager animateIn={false}>
      <Animated.View style={{ flex: 1, transform: [{ translateX: entryX }] }}>{body}</Animated.View>
    </SwipeBackPager>
  );

  function renderContent() {
    if (!community) return null;
    const accent = accentFor(community.name);
    const initial = community.name.trim().charAt(0).toUpperCase() || '#';
    const pending = community.status === 'pending';

    const goEdit = () => router.push(`/communities/edit?id=${id}`);

    const gridHeader = (
    <View>
      {/* For the owner the banner is tappable (→ edit) with a pencil cue. */}
      <TouchableOpacity activeOpacity={isOwner ? 0.9 : 1} onPress={isOwner ? goEdit : undefined} disabled={!isOwner}>
        {community.banner_url ? (
          <View style={[styles.banner, styles.bannerWithImg]}>
            <Image source={{ uri: community.banner_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            <View style={styles.genrePill}><Text style={styles.genrePillText}>{genreLabel(community.genre)}</Text></View>
          </View>
        ) : (
          <LinearGradient colors={accent as any} style={styles.banner}>
            <Text style={styles.bannerInitial}>{initial}</Text>
            <View style={styles.genrePill}><Text style={styles.genrePillText}>{genreLabel(community.genre)}</Text></View>
          </LinearGradient>
        )}
        {isOwner && (
          <View style={styles.bannerEditBadge}><Ionicons name="create-outline" size={16} color="#fff" /></View>
        )}
      </TouchableOpacity>

      <View style={styles.infoBlock}>
        {/* Title row: name/hashtag on the left, the join/joined status centered
            next to them on the right. The owner can tap the name to edit. */}
        <View style={styles.titleRow}>
          <View style={styles.titleCol}>
            {isOwner ? (
              <TouchableOpacity onPress={goEdit} activeOpacity={0.7}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>{community.name}</Text>
                  <Ionicons name="create-outline" size={18} color={colors.textSecondary} />
                </View>
                <Text style={styles.hashtag}>#{community.hashtag}</Text>
              </TouchableOpacity>
            ) : (
              <>
                <Text style={styles.name} numberOfLines={1}>{community.name}</Text>
                <Text style={styles.hashtag}>#{community.hashtag}</Text>
              </>
            )}
          </View>

          {myStatus === 'banned' ? (
            <View style={[styles.actionBtn, styles.bannedBtn]}>
              <Text style={styles.bannedText}>{t('communities.banned')}</Text>
            </View>
          ) : isMember ? (
            <TouchableOpacity
              style={[styles.actionBtn, styles.joinedBtn, mode === 'light' && { backgroundColor: joinedColor + '1A', borderColor: joinedColor + '66' }]}
              onPress={() => setMenuOpen(true)}
              disabled={busy}
            >
              <Ionicons name="checkmark" size={16} color={joinedColor} />
              <Text style={[styles.joinedText, mode === 'light' && { color: joinedColor }]}>{t('communities.joined')}</Text>
            </TouchableOpacity>
          ) : myStatus !== 'invited' && community.status === 'live' ? (
            <TouchableOpacity style={[styles.actionBtn, styles.primaryBtn]} onPress={onJoin} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryText}>{t('communities.join')}</Text>}
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.statsRow}>
          <Text style={styles.statText}>{t('communities.members', { count: formatCount(community.member_count) })}</Text>
          <Text style={styles.statDot}>·</Text>
          <Text style={styles.statText}>{t('communities.posts', { count: formatCount(community.post_count) })}</Text>
          {isMember && role && <View style={{ marginLeft: SPACING.sm }}><RoleBadge role={role} size={11} /></View>}
        </View>

        {/* Invite response (two buttons) stays full-width below the title. */}
        {myStatus === 'invited' && (
          <View style={styles.inviteBtns}>
            <TouchableOpacity style={[styles.actionBtn, styles.secondaryBtn]} onPress={() => onInvite(false)} disabled={busy}>
              <Text style={styles.secondaryText}>{t('communities.decline')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.primaryBtn]} onPress={() => onInvite(true)} disabled={busy}>
              <Text style={styles.primaryText}>{t('communities.accept')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Rules — subtitle + body, fenced by thin separators above and below. */}
        <View style={styles.divider} />
        <View style={styles.rulesBlock}>
          <Text style={styles.rulesTitle}>{t('communities.rules')}</Text>
          <Text style={styles.rulesText}>{community.guidelines || t('communities.noRules')}</Text>
        </View>
        <View style={styles.divider} />

        {/* Pending — established but not public yet */}
        {pending && (
          <View style={styles.pendingBanner}>
            <Ionicons name="time-outline" size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.pendingTitle}>{t('communities.pendingBannerTitle')}</Text>
              <Text style={styles.pendingBody}>{t('communities.pendingBannerBody', { count: community.member_count })}</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );

    return (
      <View style={styles.container}>
        <TopBar
          title={community.name}
          onBack={() => router.back()}
          /* Always available: the menu now carries Report, which every visitor
             needs — not just members. Member-only items stay gated inside. */
          onMenu={() => setMenuOpen(true)}
        />

        <ExploreGrid
          posts={posts}
          currentUserId={userId}
          refreshing={refreshing}
          onRefresh={onRefresh}
          songTiles
          onPostDeleted={(pid) => setPosts((prev) => prev.filter((p) => p.id !== pid))}
          header={gridHeader}
          emptyText={isMember ? t('communities.gridEmpty') : t('communities.memberOnlyPost')}
        />

        {/* Member menu */}
        <DragSheet visible={menuOpen} onClose={() => setMenuOpen(false)}>
          {/* Share sits first, and is the one row EVERYONE gets — members,
              managers, owners and passers-by alike. Sends the link alone
              (no accompanying text) so the recipient gets just the unfurled
              card, matching how posts and songs share; `url` is the
              iOS-only field and Android reads `message`. */}
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => {
              setMenuOpen(false);
              const link = communityShareUrl(id);
              setTimeout(() => {
                Share.share(Platform.OS === 'ios' ? { url: link } : { message: link }).catch(() => {});
              }, 280);
            }}
          >
            <Ionicons name="share-social-outline" size={20} color={colors.text} />
            <Text style={styles.menuText}>{t('postOptions.share')}</Text>
          </TouchableOpacity>
          {role === 'owner' && (
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); router.push(`/communities/edit?id=${id}`); }}>
              <Ionicons name="create-outline" size={20} color={colors.text} />
              <Text style={styles.menuText}>{t('communities.editCommunity')}</Text>
            </TouchableOpacity>
          )}
          {canManage && (
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuOpen(false); setMembersOpen(true); }}>
              <Ionicons name="people-outline" size={20} color={colors.text} />
              <Text style={styles.menuText}>{t('communities.manageMembers')}</Text>
            </TouchableOpacity>
          )}
          {/* Reporting your own community is meaningless — an owner who
              wants it gone deletes or edits it instead. */}
          {role !== 'owner' && (
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); reportCommunity(id); }}
            >
              <Ionicons name="flag-outline" size={20} color={colors.text} />
              <Text style={styles.menuText}>{t('communities.report')}</Text>
            </TouchableOpacity>
          )}
          {isMember && (
            <TouchableOpacity style={styles.menuItem} onPress={confirmLeave}>
              <Ionicons name="exit-outline" size={20} color={colors.error} />
              <Text style={[styles.menuText, { color: colors.error }]}>{t('communities.leave')}</Text>
            </TouchableOpacity>
          )}
        </DragSheet>

        {community && (
          <CommunityMembersModal
            visible={membersOpen}
            onClose={() => setMembersOpen(false)}
            communityId={id}
            callerRole={role ?? 'member'}
            currentUserId={userId}
            onChanged={load}
          />
        )}
      </View>
    );
  }
}

// How far the sheet travels off-screen, and how it resists an upward over-drag.
const SHEET_TRAVEL = 300;
function rubber(drag: number, max = 32): number {
  return max * (1 - Math.exp(-drag / max));
}

// The community 3-dot menu, as a sheet that slides up and can be flicked away.
//
// It used to be a fade-in Modal that drew a grab handle it never honoured — the
// handle was decorative and the only way out was tapping the backdrop, which is
// the one bottom sheet in the app that behaved that way. Everything here mirrors
// the app-wide 3-dot sheet in contexts/PostOptionsContext: the same 260/220ms
// entrance, the same 45pt grab strip weighted below the handle, and the same
// softened (48pt, 0.85) release thresholds.
//
// `visible` is watched rather than passed straight to the Modal so that closing
// PLAYS THE EXIT. The menu rows call setMenuOpen(false) directly, and handing
// that to Modal.visible would rip the sheet off-screen with no animation — so
// the flag drives the slide-out, and only when that finishes does the Modal
// actually unmount.
function DragSheet({ visible, onClose, children }: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const [mounted, setMounted] = useState(false);
  const translateY = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;

  const slideOut = useCallback((then?: () => void) => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: SHEET_TRAVEL, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => then?.());
  }, [translateY, backdrop]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.setValue(SHEET_TRAVEL);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      slideOut(() => setMounted(false));
    }
  }, [visible, slideOut, translateY, backdrop]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
    onPanResponderMove: (_e, g) => {
      if (g.dy < 0) {
        translateY.setValue(-rubber(Math.abs(g.dy)));
        backdrop.setValue(1);
      } else {
        translateY.setValue(g.dy);
        backdrop.setValue(Math.max(0, 1 - g.dy / SHEET_TRAVEL));
      }
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 48 || g.vy > 0.85) {
        slideOut(() => closeRef.current());
      } else {
        Animated.parallel([
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 5, speed: 16 }),
          Animated.timing(backdrop, { toValue: 1, duration: 150, useNativeDriver: true }),
        ]).start();
      }
    },
  })).current;

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={() => closeRef.current()} statusBarTranslucent>
      <View style={styles.menuOverlay}>
        <Animated.View style={[styles.menuBackdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => closeRef.current()} />
        </Animated.View>
        <Animated.View style={[styles.menuSheet, { transform: [{ translateY }] }]}>
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

function TopBar({ title, onBack, onMenu }: { title: string; onBack: () => void; onMenu?: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.topBar}>
      <TouchableOpacity style={styles.topBtn} onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.topTitle} numberOfLines={1}>{title}</Text>
      {onMenu ? (
        <TouchableOpacity style={styles.topBtn} onPress={onMenu} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
        </TouchableOpacity>
      ) : (
        <View style={styles.topBtn} />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  notFound: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  topBtn: { width: 44, height: 36, alignItems: 'center', justifyContent: 'center' },
  topTitle: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 17, fontWeight: '800' },

  skelHeader: { paddingTop: SPACING.xxl + SPACING.sm },
  skelBanner: { marginBottom: SPACING.sm },
  skelInfo: { paddingHorizontal: SPACING.md, gap: SPACING.sm },

  banner: { height: 120, padding: SPACING.md, justifyContent: 'space-between', overflow: 'hidden' },
  bannerWithImg: { justifyContent: 'flex-end' },
  bannerEditBadge: {
    position: 'absolute', right: SPACING.md, top: SPACING.md,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  bannerInitial: { color: '#fff', fontSize: 44, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 6 },
  genrePill: { alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.32)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 3 },
  genrePillText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // No horizontal padding here: ExploreGrid's ScrollView already pads the whole
  // header by H_PADDING (SPACING.md), so adding it again pushed the name/rules
  // in past the banner and the grid posts. Aligns everything to one left edge.
  infoBlock: { paddingTop: SPACING.sm + 2, gap: SPACING.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  titleCol: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 34, fontWeight: '900', letterSpacing: -0.5, flexShrink: 1 },
  hashtag: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 1 },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  statText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  statDot: { color: colors.textTertiary },

  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.lg,
  },
  primaryBtn: { backgroundColor: colors.primary },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondaryBtn: { borderWidth: 1, borderColor: colors.border, flex: 1 },
  secondaryText: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
  joinedBtn: { backgroundColor: colors.success + '1A', borderWidth: 1, borderColor: colors.success + '55' },
  joinedText: { color: colors.success, fontSize: 15, fontWeight: '700' },
  bannedBtn: { backgroundColor: colors.error + '1A' },
  bannedText: { color: colors.error, fontSize: 15, fontWeight: '700' },
  inviteBtns: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xs },

  pendingBanner: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.primary + '11', borderWidth: 1, borderColor: colors.primary + '44',
    borderRadius: RADIUS.md, padding: SPACING.sm + 2, marginTop: SPACING.xs,
  },
  pendingTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  pendingBody: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  // Rules reads as a subtitle + body, not a boxed comment card.
  rulesBlock: { gap: 3 },
  rulesTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  rulesText: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },


  // menus
  menuOverlay: { flex: 1, justifyContent: 'flex-end' },
  // Absolute-filling now, because the sheet is its own sibling that slides
  // independently — the backdrop has to fade on its own opacity while the sheet
  // translates.
  menuBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  // paddingTop moved into `grab`, which supplies the space above the handle.
  menuSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl },
  // The drag target. 45pt (16 + 4 + 24) and weighted BELOW the handle, matching
  // the app-wide 3-dot sheet — see the note on its `grab` style for why the
  // bottom side is the one that needs the room.
  grab: { alignItems: 'center', paddingTop: SPACING.md, paddingBottom: SPACING.lg },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm },
  menuText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  title: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: SPACING.sm },

  editSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl },
  editInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.md, minHeight: 120, color: colors.text, fontSize: 15,
  },
  saveBtn: { backgroundColor: colors.primary, borderRadius: RADIUS.full, alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.md },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
