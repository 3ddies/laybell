import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

// Signup lands here when Supabase says the email still needs confirming. The
// user types the 6-digit code from the confirmation email and is verified
// in-app (verifyOtp returns a session, so the root auth listener takes over
// and routes into onboarding). Tapping the emailed link instead also works —
// that path confirms in the browser, after which normal login succeeds.
const RESEND_COOLDOWN_S = 60;

export default function VerifyEmailScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The signup (or login retry) that brought us here just sent an email, so
  // the resend button starts on cooldown — Supabase rate-limits resends anyway.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const verifyingRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]);

  async function verify(token: string) {
    if (!email || verifyingRef.current) return;
    verifyingRef.current = true;
    setVerifying(true); setError(''); setNotice('');
    // 'signup' is the type for confirmation-email codes; some configurations
    // issue them as generic 'email' OTPs instead, so fall back before failing.
    let { error: err } = await supabase.auth.verifyOtp({ email, token, type: 'signup' });
    if (err) {
      const retry = await supabase.auth.verifyOtp({ email, token, type: 'email' });
      if (!retry.error) err = null;
    }
    if (err) {
      setError(/rate|security purposes/i.test(err.message) ? t('auth.rateLimited') : t('auth.codeInvalid'));
      setCode('');
    }
    // Success needs no navigation: the new session fires the root layout's
    // auth listener, which routes into onboarding/tabs.
    setVerifying(false);
    verifyingRef.current = false;
  }

  function onChangeCode(v: string) {
    const digits = v.replace(/[^0-9]/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) verify(digits);
  }

  async function resend() {
    if (!email || cooldown > 0) return;
    setError(''); setNotice('');
    const { error: err } = await supabase.auth.resend({ type: 'signup', email });
    if (err) {
      setError(/rate|security purposes/i.test(err.message) ? t('auth.rateLimited') : err.message);
    } else {
      setNotice(t('auth.resent'));
      setCooldown(RESEND_COOLDOWN_S);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.inner}>
        <View style={styles.logoSection}>
          <Image source={require('../../assets/icon.png')} style={styles.logoMark} resizeMode="cover" />
          <Text style={styles.title}>{t('auth.verifyTitle')}</Text>
          <Text style={styles.body}>{t('auth.verifyBody', { email: email ?? '' })}</Text>
        </View>

        <View style={styles.form}>
          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          {!!notice && (
            <View style={styles.noticeRow}>
              <Ionicons name="mail-unread-outline" size={15} color={colors.primary} />
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          )}

          <TextInput
            style={styles.codeInput}
            value={code}
            onChangeText={onChangeCode}
            placeholder={t('auth.codePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            editable={!verifying}
          />

          <TouchableOpacity
            style={[styles.button, (verifying || code.length < 6) && styles.buttonDisabled]}
            onPress={() => verify(code)}
            disabled={verifying || code.length < 6}
          >
            {verifying ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>{t('auth.verifyAction')}</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={resend} disabled={cooldown > 0} style={styles.resendBtn}>
            <Text style={[styles.resendText, cooldown > 0 && styles.resendDisabled]}>
              {cooldown > 0 ? t('auth.resendIn', { n: String(cooldown) }) : t('auth.resend')}
            </Text>
          </TouchableOpacity>

          <Text style={styles.spamHint}>{t('auth.spamHint')}</Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.verifiedQ')}</Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity><Text style={styles.linkText}>{t('auth.login')}</Text></TouchableOpacity>
          </Link>
        </View>
        <View style={styles.footerTight}>
          <Text style={styles.footerText}>{t('auth.wrongEmail')}</Text>
          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity><Text style={styles.linkText}>{t('auth.signUp')}</Text></TouchableOpacity>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  body: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  noticeText: { color: colors.primary, fontSize: 13, flex: 1 },

  codeInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
    color: colors.text, fontSize: 24, fontWeight: '700', textAlign: 'center', letterSpacing: 8,
  },

  button: {
    backgroundColor: colors.primary, borderRadius: RADIUS.md,
    paddingVertical: SPACING.md + 2, alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },

  resendBtn: { alignItems: 'center', paddingVertical: SPACING.xs },
  resendText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  resendDisabled: { color: colors.textTertiary, fontWeight: '500' },
  spamHint: { color: colors.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerTight: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.sm },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
