import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Keyboard,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import AuthBackdrop from '../../components/AuthBackdrop';
import AuthSubmitButton from '../../components/AuthSubmitButton';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

// Signup lands here when Supabase says the email still needs confirming. The
// user types the code from the confirmation email and is verified in-app
// (verifyOtp returns a session, so the root auth listener takes over and routes
// into onboarding). Tapping the emailed LINK works too — it deep-links back
// into the app, which sets the session and shows a confirmation (see the
// auth-link handler in app/_layout.tsx).
const RESEND_COOLDOWN_S = 60;
// Length of the emailed confirmation code. Supabase's OTP length is a project
// setting (6–10); this project issues 8. It must match, or the input truncates
// the code and submits a token that can never verify.
const CODE_LEN = 8;

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
  // Local, because the code field is not an AuthField and so does not get the
  // focus handling for free — see the note beside it.
  const [focused, setFocused] = useState(false);
  const verifyingRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]);

  async function verify(token: string) {
    if (!email || verifyingRef.current) return;
    verifyingRef.current = true;
    // The code is submitted the moment it is complete, so close the keyboard
    // with it rather than leaving it covering the result. See login.tsx.
    Keyboard.dismiss();
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
    const digits = v.replace(/[^0-9]/g, '').slice(0, CODE_LEN);
    setCode(digits);
    // Auto-submit only at the FULL length. This used to fire at 6 while the
    // project issues 8-digit codes, so it always submitted a truncated token —
    // signup could not complete, and each attempt spent one against Supabase's
    // rate limit. If the OTP length is ever reconfigured, change CODE_LEN.
    if (digits.length === CODE_LEN) verify(digits);
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior="height"
      // OFF on iOS on purpose. Resizing the container re-centres the form and
      // makes it leap; automaticallyAdjustKeyboardInsets on the ScrollView
      // below handles iOS without touching layout at all.
      enabled={Platform.OS !== 'ios'}
    >
      <AuthBackdrop />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        // Adjusts contentInset rather than resizing — see the KeyboardAvoidingView above.
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
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

          {/* NOT an AuthField, deliberately. This is an 8-digit code, and the
              wide letter-spaced centred digits are what make it legible as one
              at a glance; an icon on the left and 15px body text would make it
              look like an ordinary text box that happens to want numbers. It
              does take AuthField's focus language, though, so the four auth
              screens agree on what a live field looks like. */}
          <TextInput
            style={[styles.codeInput, focused && styles.codeInputFocused]}
            value={code}
            onChangeText={onChangeCode}
            placeholder={t('auth.codePlaceholder')}
            placeholderTextColor={colors.textMeta}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={CODE_LEN}
            autoFocus
            editable={!verifying}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />

          <AuthSubmitButton
            label={t('auth.verifyAction')}
            onPress={() => verify(code)}
            loading={verifying}
            disabled={verifying || code.length < CODE_LEN}
          />

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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  // flexGrow, not flex — see login.tsx: flex:1 on a contentContainer pins it
  // to the viewport and kills scrolling.
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  body: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  noticeText: { color: colors.primary, fontSize: 13, flex: 1 },

  // Rest state matches AuthField's: surface + hairline. It sat on surfaceLight
  // at rest, which is AuthField's FOCUSED fill, so the field looked permanently
  // active and had nowhere left to go when it actually was.
  codeInput: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
    color: colors.text, fontSize: 24, fontWeight: '700', textAlign: 'center', letterSpacing: 8,
  },
  codeInputFocused: { borderColor: colors.text, backgroundColor: colors.surfaceLight },

  resendBtn: { alignItems: 'center', paddingVertical: SPACING.xs },
  resendText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  resendDisabled: { color: colors.textTertiary, fontWeight: '500' },
  spamHint: { color: colors.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerTight: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.sm },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
