import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView, Keyboard,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../lib/supabase';
import { authRedirectUrl } from '../../lib/authLink';
import SocialAuthButtons from '../../components/SocialAuthButtons';
import AuthLogoMark from '../../components/AuthLogoMark';
// Same fill as the Listen-mode pill and the Log in button — imported, not copied.
import { LISTEN_FILL } from '../../components/ListenButton';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

type Field = { icon: any; placeholder: string; value: string; onChange: (v: string) => void; secure?: boolean; keyboard?: any; capitalize?: any; maxLength?: number };

export default function SignupScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);
  // Must be checked before an account can be created (ToS + Privacy consent).
  const [agreed, setAgreed] = useState(false);
  // Backstop for the deliberate "keep spinning on success" in handleSignup.
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (stuckTimer.current) clearTimeout(stuckTimer.current); }, []);

  async function handleSignup() {
    // Ignore surrounding whitespace (e.g. a trailing space) on the username so it
    // never trips the length checks or the letters/numbers/underscores-only rule —
    // validate and submit the trimmed value.
    const uname = username.trim();
    if (!email || !password || !confirmPassword || !uname || !displayName) { setError(t('auth.fillAllFields')); return; }
    if (password !== confirmPassword) { setError(t('auth.passwordsNoMatch')); return; }
    if (password.length < 6) { setError(t('auth.passwordMin')); return; }
    if (uname.length < 5) { setError(t('auth.usernameMin')); return; }
    if (uname.length > 30) { setError(t('auth.usernameMax')); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(uname)) { setError(t('auth.usernameChars')); return; }
    if (!agreed) { setError(t('auth.acceptTerms')); return; }

    // Close the keyboard now that we are actually submitting — after the
    // validation guards, so a rejected field does not shut the keyboard on
    // someone who has to go straight back into it. Same reasoning as login.tsx.
    Keyboard.dismiss();
    setLoading(true); setError('');
    // Capture a thrown network/timeout error into the returned shape so a rejected
    // sign-up can't leave the button stuck — the setLoading(false) below always runs.
    let data: any, signUpError: any;
    try {
      ({ data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(), password,
        options: {
          data: { username: uname.toLowerCase(), display_name: displayName.trim() },
          // Send the confirmation LINK back into the app instead of dead-ending
          // in a browser. app/_layout.tsx turns that inbound URL into a session
          // and shows a confirmation toast. The code path is unaffected.
          emailRedirectTo: authRedirectUrl(),
        },
      }));
    } catch (e: any) {
      signUpError = e;
    }
    if (signUpError) {
      if (/already registered/i.test(signUpError.message)) setError(t('auth.emailInUse'));
      else if (/rate|security purposes/i.test(signUpError.message)) setError(t('auth.rateLimited'));
      else setError(signUpError.message);
      setLoading(false);
      return;
    }
    if (data.user && !data.session) {
      // Email confirmation is required. Supabase obfuscates repeat signups (a
      // fake user with no identities, and no email is sent) — surface that as
      // "already registered" instead of sending the user to wait on a code
      // that will never arrive.
      if ((data.user.identities?.length ?? 0) === 0) {
        setError(t('auth.emailInUse'));
      } else {
        router.push({ pathname: '/(auth)/verify-email', params: { email: email.trim() } });
      }
      // Both land the user back on, or still on, this screen.
      setLoading(false);
      return;
    }

    // A session arrived immediately (confirmation disabled), so the root auth
    // listener is now fetching the profile and routing into onboarding. The
    // spinner deliberately keeps running until this screen unmounts — see the
    // matching note in login.tsx: stopping it here is what made a working
    // sign-up look like a tap that did nothing.
    stuckTimer.current = setTimeout(() => setLoading(false), 8000);
  }

  const fields: Field[] = [
    { icon: 'person-outline', placeholder: t('auth.displayName'), value: displayName, onChange: setDisplayName },
    { icon: 'at-outline', placeholder: t('auth.username'), value: username, onChange: setUsername, capitalize: 'none', maxLength: 30 },
    { icon: 'mail-outline', placeholder: t('auth.email'), value: email, onChange: setEmail, capitalize: 'none', keyboard: 'email-address' },
    { icon: 'lock-closed-outline', placeholder: t('auth.password'), value: password, onChange: setPassword, secure: true },
    { icon: 'lock-closed-outline', placeholder: t('auth.confirmPassword'), value: confirmPassword, onChange: setConfirmPassword, secure: true },
  ];

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>

        <View style={styles.logoSection}>
          <AuthLogoMark size={72} />
          <View style={styles.logoWrap}>
            <Text style={styles.logo}>Laybell</Text>
            <Text style={styles.tm}>™</Text>
          </View>
          <Text style={styles.tagline}>{t('auth.signupTagline')}</Text>
        </View>

        <View style={styles.form}>
          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {fields.map((f, i) => (
            <View key={i} style={styles.inputWrap}>
              <Ionicons name={f.icon} size={18} color={colors.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={f.placeholder}
                placeholderTextColor={colors.textTertiary}
                value={f.value}
                onChangeText={f.onChange}
                secureTextEntry={f.secure && !showPass}
                keyboardType={f.keyboard}
                autoCapitalize={f.capitalize ?? 'words'}
                maxLength={f.maxLength}
              />
              {f.secure && (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={showPass ? t('a11y.hidePassword') : t('a11y.showPassword')} onPress={() => setShowPass(p => !p)}>
                  <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
          ))}

          <View style={styles.consentRow}>
            <TouchableOpacity
              onPress={() => setAgreed(a => !a)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={[styles.checkbox, agreed && styles.checkboxOn]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
            >
              {agreed && <Ionicons name="checkmark" size={15} color={colors.text} />}
            </TouchableOpacity>
            <Text style={styles.consent}>
              {/* Split the localized template on {terms}/{privacy} so each language
                  can place the two tappable links wherever its grammar needs. */}
              {t('auth.consent').split(/(\{terms\}|\{privacy\})/).map((part, i) => {
                if (part === '{terms}') {
                  return <Text key={i} style={styles.consentLink} onPress={() => router.push('/terms-of-service')}>{t('about.terms')}</Text>;
                }
                if (part === '{privacy}') {
                  return <Text key={i} style={styles.consentLink} onPress={() => router.push('/privacy-policy')}>{t('about.privacyPolicy')}</Text>;
                }
                return part;
              })}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.button, (loading || !agreed) && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={loading || !agreed}
            activeOpacity={0.85}
          >
            {/* Gradient fill, matching the Listen pill and the Log in button. */}
            <LinearGradient
              colors={LISTEN_FILL}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>{t('auth.createAccount')}</Text>}
          </TouchableOpacity>

          {/* Express sign-up — Google (and Apple where available). The provider
              account IS the consent-carrying identity; new users still complete
              the same onboarding (incl. the required About-you step). */}
          <SocialAuthButtons onError={setError} />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.haveAccount')}</Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity><Text style={styles.linkText}>{t('auth.login')}</Text></TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xxl },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logo: { fontSize: 36, fontWeight: '800', color: colors.text, letterSpacing: 1 },
  // Wordmark + ™ tucked into the bottom-right corner — matches login/home header.
  logoWrap: { flexDirection: 'row', alignItems: 'flex-end' },
  tm: { fontSize: 11, fontWeight: '400', color: colors.primaryLight, marginLeft: 1, marginBottom: 4 },
  tagline: { fontSize: 14, color: colors.textSecondary },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, gap: SPACING.sm,
  },
  inputIcon: { flexShrink: 0 },
  input: { flex: 1, paddingVertical: SPACING.md, color: colors.text, fontSize: 15 },

  // backgroundColor is only the pre-paint frame; the fill is the LinearGradient
  // child, and overflow:hidden keeps it inside the rounded corners.
  button: { backgroundColor: colors.primary, borderRadius: RADIUS.md, overflow: 'hidden', paddingVertical: SPACING.md + 2, alignItems: 'center', marginTop: SPACING.sm },
  buttonDisabled: { opacity: 0.5 },
  // White, not colors.text — the label sits on the gradient in both themes.
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm, marginTop: SPACING.xs },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, marginTop: 1,
    borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  consent: { flex: 1, color: colors.textTertiary, fontSize: 12, lineHeight: 18 },
  // Neutral, not orange (owner, 2026-08-28). These are the ToS and Privacy
  // links inside the consent line, and orange made them read as the loudest
  // thing on the screen — competing with the Create account button for the eye
  // when they are a legal footnote. The underline is what keeps them obviously
  // tappable once the colour is gone, so this stays a11y-sound rather than
  // relying on colour alone.
  consentLink: { color: colors.text, fontWeight: '700', textDecorationLine: 'underline' },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
