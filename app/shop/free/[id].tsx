import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../../components/SwipeBackPager';
import { DetailSkeleton } from '../../../components/Skeleton';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../../constants/theme';
import { useTheme, useThemedStyles } from '../../../contexts/ThemeContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { useFollow } from '../../../contexts/FollowContext';
import { notifySuccess } from '../../../lib/haptics';
import {
  checkFreeConditions, fetchListing, requestToBuy,
  type FreeConditionState, type ShopListing,
} from '../../../lib/shop';

// The free-claim screen. Reached by tapping the Free button on a listing whose
// claim is GATED (follow the seller, like some posts).
//
// It used to be a checklist wedged under that button. It earns its own screen
// because the conditions are a task list, and most of those tasks navigate away
// — tapping "like this post" left the listing, came back, and had to re-find
// its place. Here the whole screen IS the task, and returning to it re-verifies
// on focus.
//
// The claim button is the real one: it is disabled until every condition is met
// and then performs the claim, rather than sending you back to press a
// different button somewhere else.
export default function FreeClaimScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { following, toggleFollow } = useFollow();

  const [listing, setListing] = useState<ShopListing | null>(null);
  const [conds, setConds] = useState<FreeConditionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchListing(id)
      .then((l) => { setListing(l); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  // Re-check whenever this screen comes back into view — every condition is
  // satisfied by going somewhere else and doing something, so the moment the
  // user returns is exactly when the answer may have changed. `following` is a
  // dep so a follow toggled from here updates without a round trip elsewhere.
  useFocusEffect(useCallback(() => {
    if (listing) checkFreeConditions(listing).then(setConds).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id, following]));

  const sellerName = listing?.seller?.display_name || listing?.seller?.username || '';
  const ready = !!conds?.allMet;

  async function claim() {
    if (!listing || busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      // The server re-verifies the conditions in shop_order_precheck — this is
      // the same call the listing screen makes, so a client that lied about
      // `ready` still gets refused.
      const o = await requestToBuy(listing, '', 'free', 0);
      if (o.status === 'delivered') {
        notifySuccess();
        setClaimed(true);
        // Back to the listing, which now shows the Download button.
        setTimeout(() => router.back(), 700);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      setError(msg.includes('rate_limited') ? t('shop.rateLimited') : t('shop.freeCondUnmetErr'));
      // A refusal means our view of the conditions was stale; re-read it.
      checkFreeConditions(listing).then(setConds).catch(() => {});
    }
    setBusy(false);
  }

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('a11y.back')}
            onPress={() => router.back()}
            style={styles.headerBtn}
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{t('shop.unlockTitle')}</Text>
          <View style={styles.headerBtn} />
        </View>

        {loading ? (
          <DetailSkeleton />
        ) : !listing ? (
          <View style={styles.center}><Text style={styles.muted}>{t('shop.notFound')}</Text></View>
        ) : (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.item}>
              {listing.cover_url ? (
                <Image source={{ uri: listing.cover_url }} style={styles.cover} />
              ) : (
                <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                  <Ionicons name="musical-notes" size={20} color={colors.primary} />
                </LinearGradient>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle} numberOfLines={2}>{listing.title}</Text>
                {!!sellerName && <Text style={styles.itemSeller} numberOfLines={1}>{sellerName}</Text>}
              </View>
            </View>

            <Text style={styles.intro}>{t('shop.freeClaimIntro')}</Text>

            <View style={styles.card}>
              {!!listing.free_requires_follow && (
                <TouchableOpacity
                  style={styles.row}
                  onPress={() => { if (!conds?.followMet) toggleFollow(listing.user_id); }}
                  activeOpacity={conds?.followMet ? 1 : 0.7}
                  disabled={!conds}
                >
                  <Ionicons
                    name={conds?.followMet ? 'checkmark-circle' : 'person-add-outline'}
                    size={20}
                    color={conds?.followMet ? colors.success : colors.textSecondary}
                  />
                  <Text style={[styles.rowText, conds?.followMet && styles.rowTextMet]}>
                    {t('shop.unlockFollow', { name: sellerName || '—' })}
                  </Text>
                  {!conds?.followMet && <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />}
                </TouchableOpacity>
              )}
              {(conds?.likes ?? []).map((lk, i) => (
                <TouchableOpacity
                  key={lk.postId}
                  style={styles.row}
                  onPress={() => router.push(`/post/${lk.postId}`)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={lk.met ? 'checkmark-circle' : 'heart-outline'}
                    size={20}
                    color={lk.met ? colors.success : colors.textSecondary}
                  />
                  <Text style={[styles.rowText, lk.met && styles.rowTextMet]}>
                    {t('shop.unlockLike', { n: i + 1 })}
                  </Text>
                  {!lk.met && <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />}
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.hint, ready && { color: colors.success }]}>
              {ready ? t('shop.unlockReady') : t('shop.unlockUnmet')}
            </Text>

            {!!error && <Text style={styles.error}>{error}</Text>}

            {/* The real claim. Locked until every box is ticked — the same
                condition the server enforces, so this never promises something
                the backend will refuse. */}
            <TouchableOpacity
              style={[styles.claimBtn, !ready && styles.claimBtnLocked]}
              onPress={claim}
              disabled={!ready || busy || claimed}
              activeOpacity={0.85}
            >
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name={claimed ? 'checkmark-circle' : ready ? 'gift' : 'lock-closed'} size={18} color="#fff" />
                  <Text style={styles.claimText}>
                    {claimed ? t('shop.unlockReady') : t('shop.freeClaimBtn')}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm },
  headerBtn: { width: 40, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: c.textSecondary, fontSize: 14 },
  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },

  item: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  cover: { width: 56, height: 56, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceLight },
  itemTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  itemSeller: { color: c.textSecondary, fontSize: 13, marginTop: 2 },

  intro: { color: c.textSecondary, fontSize: 13.5, lineHeight: 19 },
  card: {
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.md },
  rowText: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600' },
  rowTextMet: { color: c.textTertiary, textDecorationLine: 'line-through' },

  hint: { color: c.textSecondary, fontSize: 12.5, textAlign: 'center' },
  error: { color: c.error, fontSize: 13, textAlign: 'center' },

  claimBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 14,
  },
  claimBtnLocked: { opacity: 0.45 },
  claimText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
