import { useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  donate, donationBreakdown, hostCanReceive, hostFeeRate, fmtCents,
  DONATION_PRESETS_CENTS, DONATION_MIN_CENTS, DONATION_MAX_CENTS,
} from '../lib/donations';
import type { LiveStream } from '../lib/live';

// Bottom-sheet donation flow for the live viewer. The host must be Premium to
// receive (checked here for the UI + enforced server-side by donation_guard).
// Payment is simulated; the sheet just shows the split (Laybell 15% + est. tax)
// so the donor sees exactly what the host takes home.

export default function LiveDonateModal({ visible, stream, onClose, onDonated }: {
  visible: boolean;
  stream: LiveStream;
  onClose: () => void;
  onDonated: (amountCents: number, message: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [amount, setAmount] = useState<number>(DONATION_PRESETS_CENTS[1]); // default $2
  const [customText, setCustomText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hostName = stream.profile?.display_name || stream.profile?.username || t('live.donate.host');
  const canReceive = hostCanReceive(stream.profile?.premium_until);
  const b = donationBreakdown(amount, hostFeeRate(stream.profile?.premium_until));
  const validAmount = amount >= DONATION_MIN_CENTS && amount <= DONATION_MAX_CENTS;

  function pickPreset(cents: number) {
    setAmount(cents);
    setCustomText('');
  }

  function onCustom(text: string) {
    // Dollars → cents; ignore anything but digits + one dot.
    const cleaned = text.replace(/[^0-9.]/g, '');
    setCustomText(cleaned);
    const dollars = parseFloat(cleaned);
    if (!isNaN(dollars)) setAmount(Math.round(dollars * 100));
  }

  async function confirm() {
    if (!validAmount || busy) return;
    setBusy(true);
    const msg = message.trim();
    const res = await donate(stream.id, amount, msg);
    setBusy(false);
    if (res.ok) {
      onDonated(amount, msg);
      setMessage('');
      onClose();
    } else {
      const key =
        res.reason === 'not_premium' ? 'live.donate.errNotPremium'
        : res.reason === 'self' ? 'live.donate.errSelf'
        : res.reason === 'signed_out' ? 'live.donate.errSignedOut'
        : 'live.donate.errUnavailable';
      // Surface inline instead of an Alert so the sheet stays put.
      setError(t(key));
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <View style={styles.titleRow}>
                <Ionicons name="gift" size={20} color={colors.primary} />
                <Text style={styles.title} numberOfLines={1}>{t('live.donate.title', { name: hostName })}</Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {!canReceive ? (
              <View style={styles.locked}>
                <Ionicons name="lock-closed-outline" size={28} color={colors.textTertiary} />
                <Text style={styles.lockedText}>{t('live.donate.lockedBody', { name: hostName })}</Text>
              </View>
            ) : (
              <>
                <View style={styles.presetGrid}>
                  {DONATION_PRESETS_CENTS.map((c) => {
                    const on = amount === c && !customText;
                    return (
                      <TouchableOpacity key={c} style={[styles.preset, on && styles.presetOn]} onPress={() => pickPreset(c)} activeOpacity={0.85}>
                        <Text style={[styles.presetText, on && styles.presetTextOn]}>{fmtCents(c)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <View style={styles.customRow}>
                  <Text style={styles.customLabel}>{t('live.donate.custom')}</Text>
                  <View style={styles.customInputWrap}>
                    <Text style={styles.dollar}>$</Text>
                    <TextInput
                      style={styles.customInput}
                      placeholder="0.00"
                      placeholderTextColor={colors.textTertiary}
                      keyboardType="decimal-pad"
                      value={customText}
                      onChangeText={onCustom}
                      maxLength={7}
                    />
                  </View>
                </View>

                {/* Message shown live to the host + room with the tip. */}
                <View style={styles.msgWrap}>
                  <TextInput
                    style={styles.msgInput}
                    placeholder={t('live.donate.messagePlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                    value={message}
                    onChangeText={setMessage}
                    maxLength={200}
                    multiline
                  />
                  {message.length > 0 && <Text style={styles.msgCount}>{200 - message.length}</Text>}
                </View>

                {/* Split so the donor sees exactly what the host takes home. */}
                <View style={styles.breakdown}>
                  <Row k={t('live.donate.hostGets', { name: hostName })} v={fmtCents(b.payoutCents)} styles={styles} strong />
                  <Row k={t('live.donate.fee')} v={`-${fmtCents(b.feeCents)}`} styles={styles} />
                  <Row k={t('live.donate.tax')} v={`+${fmtCents(b.taxCents)}`} styles={styles} />
                  <View style={styles.divider} />
                  <Row k={t('live.donate.youPay')} v={fmtCents(b.totalChargeCents)} styles={styles} strong />
                </View>

                {!!error && <Text style={styles.error}>{error}</Text>}

                <TouchableOpacity
                  style={[styles.cta, (!validAmount || busy) && styles.ctaDisabled]}
                  onPress={confirm}
                  disabled={!validAmount || busy}
                  activeOpacity={0.85}
                >
                  {/* Green (money) to match the donate button, not the orange brand. */}
                  <LinearGradient colors={['#22C55E', '#16A34A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.ctaInner}>
                    {busy ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <>
                        <Ionicons name="gift" size={16} color="#fff" />
                        <Text style={styles.ctaText}>{t('live.donate.send', { amount: fmtCents(b.totalChargeCents) })}</Text>
                      </>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
                <Text style={styles.note}>{t('live.donate.note')}</Text>
              </>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function Row({ k, v, styles, strong }: { k: string; v: string; styles: any; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowKey, strong && styles.rowStrong]} numberOfLines={1}>{k}</Text>
      <Text style={[styles.rowVal, strong && styles.rowStrong]}>{v}</Text>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.background, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    padding: SPACING.lg, paddingBottom: SPACING.xxl, gap: SPACING.md,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  title: { color: c.text, fontSize: 17, fontWeight: '800', flexShrink: 1 },

  locked: { alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.xl },
  lockedText: { color: c.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, paddingHorizontal: SPACING.md },

  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  preset: {
    flexGrow: 1, minWidth: '30%', alignItems: 'center', paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceLight,
  },
  presetOn: { borderColor: c.primary, backgroundColor: c.primary + '18' },
  presetText: { color: c.text, fontSize: 16, fontWeight: '800' },
  presetTextOn: { color: c.primary },

  customRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md },
  customLabel: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  customInputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 110,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceLight,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  dollar: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
  customInput: { flex: 1, color: c.text, fontSize: 15, fontWeight: '700', padding: 0 },

  msgWrap: {
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceLight,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  msgInput: { color: c.text, fontSize: 14, minHeight: 38, maxHeight: 90, padding: 0, textAlignVertical: 'top' },
  msgCount: { alignSelf: 'flex-end', color: c.textTertiary, fontSize: 11, marginTop: 2 },

  breakdown: {
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: c.border,
    padding: SPACING.md, gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md },
  rowKey: { color: c.textSecondary, fontSize: 13, flexShrink: 1 },
  rowVal: { color: c.text, fontSize: 13, fontWeight: '600' },
  rowStrong: { color: c.text, fontSize: 15, fontWeight: '800' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 2 },

  error: { color: c.error, fontSize: 12, textAlign: 'center' },

  cta: { borderRadius: RADIUS.full, overflow: 'hidden' },
  ctaDisabled: { opacity: 0.4 },
  ctaInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: SPACING.md + 2 },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  note: { color: c.textTertiary, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
