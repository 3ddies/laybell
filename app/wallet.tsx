import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  TextInput, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../components/SwipeBackPager';
import ConfirmDialog from '../components/ConfirmDialog';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { reactionPop, notifySuccess } from '../lib/haptics';
import { fmtCents } from '../lib/donations';
import {
  fetchWalletBalance, getPayoutMethod, savePayoutMethod, clearPayoutMethod,
  requestPayout, type WalletBalance, type PayoutMethod,
} from '../lib/wallet';

// The Wallet — earned balance (live donations + shop sales, real numbers) and a
// scaffolded path to move it to a bank. Real payouts land when Laybell's payment
// processor goes live; until then Transfer records a simulated request and the
// payout method is a display-only label (see lib/wallet).

const GREEN: [string, string] = ['#22C55E', '#16A34A'];

export default function WalletScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [method, setMethod] = useState<PayoutMethod | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Add-method inline form.
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'bank' | 'card'>('bank');
  const [label, setLabel] = useState('');

  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [transferred, setTransferred] = useState(false);

  const load = useCallback(async () => {
    const [b, m] = await Promise.all([fetchWalletBalance(), getPayoutMethod()]);
    setBalance(b);
    setMethod(m);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const total = balance?.totalCents ?? 0;

  async function saveMethod() {
    if (!label.trim()) return;
    await savePayoutMethod(kind, label.trim());
    reactionPop();
    setAdding(false);
    setLabel('');
    setMethod(await getPayoutMethod());
  }

  async function doTransfer() {
    setConfirmTransfer(false);
    const res = await requestPayout(total);
    if (res.ok) { notifySuccess(); setTransferred(true); }
  }

  function onCashOut() {
    if (total <= 0) return;
    if (!method) { setAdding(true); return; }
    setConfirmTransfer(true);
  }

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
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
              <Text style={styles.balanceValue}>{fmtCents(total)}</Text>
              <View style={styles.balanceBreak}>
                <View style={styles.breakItem}>
                  <Ionicons name="gift" size={13} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.breakText}>{t('wallet.fromTips', { amount: fmtCents(balance?.donationCents ?? 0) })}</Text>
                </View>
                <View style={styles.breakItem}>
                  <Ionicons name="bag-handle" size={13} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.breakText}>{t('wallet.fromShop', { amount: fmtCents(balance?.shopCents ?? 0) })}</Text>
                </View>
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
                <Text style={styles.pendingText}>{t('wallet.transferPending', { amount: fmtCents(total) })}</Text>
              </View>
            )}

            {/* Payout method */}
            <Text style={styles.sectionTitle}>{t('wallet.payoutMethod')}</Text>
            {method ? (
              <View style={styles.methodRow}>
                <View style={styles.methodIcon}>
                  <Ionicons name={method.kind === 'card' ? 'card' : 'business'} size={18} color={colors.text} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.methodLabel} numberOfLines={1}>{method.label}</Text>
                  <Text style={styles.methodSub}>{t(method.kind === 'card' ? 'wallet.methodCard' : 'wallet.methodBank')}</Text>
                </View>
                <TouchableOpacity onPress={async () => { await clearPayoutMethod(); setMethod(null); }} hitSlop={8}>
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </TouchableOpacity>
              </View>
            ) : adding ? (
              <View style={styles.addCard}>
                <View style={styles.kindRow}>
                  {(['bank', 'card'] as const).map((k) => (
                    <TouchableOpacity key={k} style={[styles.kindBtn, kind === k && styles.kindBtnOn]} onPress={() => setKind(k)}>
                      <Ionicons name={k === 'card' ? 'card-outline' : 'business-outline'} size={16} color={kind === k ? colors.success : colors.textSecondary} />
                      <Text style={[styles.kindText, kind === k && { color: colors.success }]}>{t(k === 'card' ? 'wallet.methodCard' : 'wallet.methodBank')}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.input}
                  placeholder={t('wallet.labelPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={label}
                  onChangeText={setLabel}
                  maxLength={40}
                  autoFocus
                />
                <Text style={styles.hint}>{t('wallet.labelHint')}</Text>
                <View style={styles.addActions}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => { setAdding(false); setLabel(''); }}>
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.saveBtn, !label.trim() && { opacity: 0.5 }]} onPress={saveMethod} disabled={!label.trim()}>
                    <Text style={styles.saveText}>{t('wallet.save')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.addRow} onPress={() => setAdding(true)} activeOpacity={0.8}>
                <Ionicons name="add-circle-outline" size={20} color={colors.success} />
                <Text style={styles.addText}>{t('wallet.addMethod')}</Text>
              </TouchableOpacity>
            )}

            {/* Honest scaffold note */}
            <View style={styles.note}>
              <Ionicons name="information-circle-outline" size={15} color={colors.textTertiary} />
              <Text style={styles.noteText}>{t('wallet.scaffoldNote')}</Text>
            </View>
          </ScrollView>
        )}

        <ConfirmDialog
          visible={confirmTransfer}
          title={t('wallet.confirmTitle', { amount: fmtCents(total) })}
          message={t('wallet.confirmBody', { label: method?.label ?? '' })}
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
