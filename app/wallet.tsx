import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  RefreshControl, Alert, Linking, AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../components/SwipeBackPager';
import ConfirmDialog from '../components/ConfirmDialog';
import { RADIUS, SPACING, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { reactionPop, notifySuccess } from '../lib/haptics';
import { fmtCents } from '../lib/donations';
import {
  fetchWalletBalance, type WalletBalance,
} from '../lib/wallet';
import {
  fetchPayoutStatus, startPayoutOnboarding, requestPayout, PAYOUT_MIN_CENTS,
  type PayoutStatus,
} from '../lib/payouts';

// The Wallet — earned balance and the path to move it to a bank.
//
// Payout setup is real Stripe Connect: bank details go to Stripe, which verifies
// identity and owns the payout rails. Laybell stores only an account id and never
// sees an account number. This replaced a local scaffold that stored a typed
// label like "Chase ••1234" and did nothing.
//
// The TRANSFER itself is still gated behind PLATFORM_COLLECTS_* in lib/wallet —
// a creator can connect a bank before Laybell is ready to send money, and being
// ready to receive is worth doing early.

// One definition of money-green, in the theme. This pair was written out by
// hand in three files; the tip alert becoming green made that a fourth, which
// is one more than any colour should be able to drift in.
const GREEN = GRADIENTS.money;

export default function WalletScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [payout, setPayout] = useState<PayoutStatus>({
    connected: false, payoutsEnabled: false, detailsSubmitted: false,
  });
  const [onboarding, setOnboarding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [transferred, setTransferred] = useState(false);
  // A payout is a network round trip that moves real money; the button has to
  // stop accepting taps for the duration or a double-tap becomes a double
  // request. (The server refuses the second one — one pending payout per user —
  // but the user would see a confusing error rather than nothing happening.)
  const [transferring, setTransferring] = useState(false);
  // Snapshotted at transfer time — see doTransfer.
  const [transferredCents, setTransferredCents] = useState(0);

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([fetchWalletBalance(), fetchPayoutStatus()]);
    setBalance(b);
    setPayout(p);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Onboarding happens in the system browser, so the app is backgrounded while it
  // runs. Re-check on return: Stripe won't tell us the user finished, and without
  // this the screen keeps saying "set up payouts" to someone who just did.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') fetchPayoutStatus().then(setPayout);
    });
    return () => sub.remove();
  }, []);

  async function openOnboarding() {
    if (onboarding) return;
    setOnboarding(true);
    const res = await startPayoutOnboarding();
    setOnboarding(false);
    // The second line carries the server's actual reason (Stripe's own words) —
    // a setup failure the user can't name is a support ticket, not a retry.
    if ('error' in res) { Alert.alert(t('wallet.payoutSetupFailed'), res.error); return; }
    // A REAL browser, never a WebView: the flow collects identity and bank
    // details, which people are right to want in a browser they recognise — and
    // Stripe's own guidance is that embedded WebViews break parts of it. But it
    // presents as the IN-APP Safari sheet (slides over Laybell, Done returns),
    // not a bounce out to the Safari app — same security, native feel; owner
    // asked for this after the first bounce-out felt clunky. When the sheet
    // closes we refresh immediately instead of waiting for the AppState listener
    // (the sheet doesn't background the app, so that listener never fires).
    try {
      await WebBrowser.openBrowserAsync(res.url);
      fetchPayoutStatus().then(setPayout);
    } catch {
      Linking.openURL(res.url).catch(() => Alert.alert(t('wallet.payoutSetupFailed')));
    }
  }

  const total = balance?.totalCents ?? 0;
  // The headline is the AVAILABLE balance — the same number the Transfer button
  // acts on. It used to fall back to `lifetimeCents` whenever payoutsAvailable()
  // was false, which is hardcoded false: so the card read "$100 Earned on
  // Laybell" (including funds still on hold) while tapping Transfer offered $40.
  // The held portion is already shown as its own line below.
  const headline = total;

  async function doTransfer() {
    setConfirmTransfer(false);
    setTransferring(true);
    const res = await requestPayout(total);
    setTransferring(false);
    if (res.ok) {
      notifySuccess();
      // Capture the amount BEFORE refreshing. The banner interpolates it, and
      // load() sets the balance to its post-payout value — so cashing out your
      // whole balance rendered "Transfer of $0.00 sent".
      setTransferredCents(total);
      setTransferred(true);
      load();  // the ledger is already debited — reflect it rather than waiting
      return;
    }
    // Every failure gets a specific message. The previous version of this
    // function silently did nothing on failure, which read as "it worked".
    const known = ['below_minimum', 'insufficient_available', 'payout_already_pending',
                   'no_connected_account', 'payouts_not_enabled'];
    Alert.alert(
      t('wallet.transferFailed'),
      known.includes(res.error)
        ? t(`wallet.err.${res.error}` as any, { min: fmtCents(PAYOUT_MIN_CENTS) })
        : t('wallet.err.generic'),
    );
  }

  function onCashOut() {
    if (total <= 0 || transferring) return;
    // No Stripe account able to receive money yet — send them to set it up
    // rather than into a confirm dialog for a transfer that cannot complete.
    // `payoutsEnabled`, not `connected`: someone mid-verification can't be paid.
    if (!payout.payoutsEnabled) { reactionPop(); openOnboarding(); return; }
    // Checked here as well as on the server so the common case is a clear
    // explanation instead of a round trip that comes back with an error.
    if (total < PAYOUT_MIN_CENTS) {
      Alert.alert(t('wallet.transferFailed'), t('wallet.err.below_minimum', { min: fmtCents(PAYOUT_MIN_CENTS) }));
      return;
    }
    setConfirmTransfer(true);
  }

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('wallet.title')}</Text>
          <View style={styles.headerBtn} />
        </View>

        {loading ? (
          <View style={styles.loadingCenter}><ActivityIndicator color={colors.textSecondary} /></View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.textSecondary}
                onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              />
            }
          >
            {/* Balance card */}
            <LinearGradient colors={GREEN} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>{t('wallet.available')}</Text>
              <Text style={styles.balanceValue}>{fmtCents(headline)}</Text>
              <View style={styles.balanceBreak}>
                <View style={styles.breakItem}>
                  <Ionicons name="gift" size={13} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.breakText}>{t('wallet.fromTips', { amount: fmtCents(balance?.donationCents ?? 0) })}</Text>
                </View>
                <View style={styles.breakItem}>
                  <Ionicons name="bag-handle" size={13} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.breakText}>{t('wallet.fromShop', { amount: fmtCents(balance?.shopCents ?? 0) })}</Text>
                </View>
                {/* Money on a hold is the seller's, but not yet withdrawable — a
                    chargeback window has to pass first. Saying so up front avoids
                    the "where is my money" support ticket. */}
                {!!balance?.heldCents && (
                  <View style={styles.breakItem}>
                    <Ionicons name="time-outline" size={13} color="rgba(255,255,255,0.9)" />
                    <Text style={styles.breakText}>{t('wallet.pending', { amount: fmtCents(balance.heldCents) })}</Text>
                  </View>
                )}
              </View>
            </LinearGradient>

            {/* Transfer CTA */}
            <TouchableOpacity
              style={[styles.transferBtn, total <= 0 && styles.transferBtnOff]}
              onPress={onCashOut}
              disabled={total <= 0}
              activeOpacity={0.85}
            >
              <LinearGradient colors={GREEN} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.transferInner}>
                <Ionicons name="arrow-up-circle" size={18} color="#fff" />
                <Text style={styles.transferText}>{t('wallet.transfer')}</Text>
              </LinearGradient>
            </TouchableOpacity>
            {transferred && (
              <View style={styles.pendingRow}>
                <Ionicons name="time-outline" size={14} color={colors.success} />
                <Text style={styles.pendingText}>{t('wallet.transferPending', { amount: fmtCents(transferredCents) })}</Text>
              </View>
            )}

            {/* Credits live here too. Earnings and credits are the two directions
                money moves for a user, and someone who came looking for "my money"
                will look in exactly one place. */}
            <TouchableOpacity
              style={styles.creditsRow}
              onPress={() => router.push('/credits')}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={t('account.credits')}
            >
              <View style={styles.creditsIcon}>
                <Ionicons name="diamond-outline" size={18} color={colors.primary} />
              </View>
              <View style={styles.creditsBody}>
                <Text style={styles.creditsLabel}>{t('account.credits')}</Text>
                <Text style={styles.creditsSub}>{t('account.creditsSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>

            {/* Payouts — real Stripe Connect onboarding.
                This replaced a local scaffold that stored a user-typed label like
                "Chase ••1234" and did nothing. Bank details now go to Stripe and
                never touch Laybell: Stripe collects them, verifies identity, and
                owns the payout rails. Laybell holds only an account id. */}
            <Text style={styles.sectionTitle}>{t('wallet.payoutMethod')}</Text>
            {payout.payoutsEnabled ? (
              <View style={styles.methodRow}>
                <View style={styles.methodIcon}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.methodLabel}>{t('wallet.payoutsReady')}</Text>
                  <Text style={styles.methodSub}>{t('wallet.payoutsReadySub')}</Text>
                </View>
              </View>
            ) : payout.connected ? (
              // Form submitted, Stripe still verifying. Distinguished from "not
              // started" on purpose — telling someone to sign up again when they
              // already have is how you get duplicate accounts and support tickets.
              <TouchableOpacity style={styles.addRow} onPress={openOnboarding} activeOpacity={0.8} disabled={onboarding}>
                {onboarding
                  ? <ActivityIndicator size="small" color={colors.success} />
                  : <Ionicons name="time-outline" size={20} color={colors.textSecondary} />}
                <Text style={styles.addText}>{t('wallet.payoutsPending')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.addRow} onPress={openOnboarding} activeOpacity={0.8} disabled={onboarding}>
                {onboarding
                  ? <ActivityIndicator size="small" color={colors.success} />
                  : <Ionicons name="add-circle-outline" size={20} color={colors.success} />}
                <Text style={styles.addText}>{t('wallet.setUpPayouts')}</Text>
              </TouchableOpacity>
            )}

            {/* Honest scaffold note */}
            <View style={styles.note}>
              <Ionicons name="information-circle-outline" size={15} color={colors.textTertiary} />
              <Text style={styles.noteText}>{t('wallet.scaffoldNote')}</Text>
            </View>
          </ScrollView>
        )}

        {/* Stripe holds the bank details, so Laybell has no account label to show
            — and shouldn't. "your connected bank account" is both accurate and the
            most it can honestly say. */}
        <ConfirmDialog
          visible={confirmTransfer}
          title={t('wallet.confirmTitle', { amount: fmtCents(total) })}
          message={t('wallet.confirmBodyStripe')}
          confirmLabel={t('wallet.transfer')}
          cancelLabel={t('common.cancel')}
          icon="arrow-up-circle-outline"
          accentColor={colors.success}
          onConfirm={doTransfer}
          onCancel={() => setConfirmTransfer(false)}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  loadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: 40 },

  balanceCard: { borderRadius: RADIUS.xl, padding: SPACING.lg, gap: 4 },
  balanceLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  balanceValue: { color: '#fff', fontSize: 40, fontWeight: '900', letterSpacing: -1 },
  balanceBreak: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md, marginTop: 8 },
  breakItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  breakText: { color: 'rgba(255,255,255,0.92)', fontSize: 12.5, fontWeight: '600' },

  transferBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  transferBtnOff: { opacity: 0.45 },
  transferInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: SPACING.md },
  transferText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  pendingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: -4 },
  pendingText: { color: c.textSecondary, fontSize: 12.5, fontWeight: '600' },

  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '800', marginTop: SPACING.sm },
  creditsRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    padding: SPACING.md, marginTop: SPACING.sm,
  },
  creditsIcon: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surfaceLight,
  },
  creditsBody: { flex: 1 },
  creditsLabel: { color: c.text, fontSize: 15, fontWeight: '600' },
  creditsSub: { color: c.textSecondary, fontSize: 12, marginTop: 1 },
  methodRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12,
  },
  methodIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  methodLabel: { color: c.text, fontSize: 14, fontWeight: '700' },
  methodSub: { color: c.textTertiary, fontSize: 12, marginTop: 1 },
  addRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14,
  },
  addText: { color: c.success, fontSize: 14, fontWeight: '700' },
  addCard: {
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12, gap: 10,
  },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, paddingVertical: 10,
  },
  kindBtnOn: { borderColor: c.success, backgroundColor: c.success + '14' },
  kindText: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  input: { backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 11, color: c.text, fontSize: 15 },
  hint: { color: c.textTertiary, fontSize: 11.5, lineHeight: 16 },
  addActions: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingVertical: 11 },
  cancelText: { color: c.textSecondary, fontSize: 14, fontWeight: '600' },
  saveBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.success, borderRadius: RADIUS.full, paddingVertical: 11 },
  saveText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  note: { flexDirection: 'row', gap: 7, marginTop: SPACING.sm, paddingHorizontal: 2 },
  noteText: { flex: 1, color: c.textTertiary, fontSize: 12, lineHeight: 17 },
});
