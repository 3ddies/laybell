import {
  View, Text, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Keyboard,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import SocialAuthButtons from '../../components/SocialAuthButtons';
import AuthLogoMark from '../../components/AuthLogoMark';
import AuthBackdrop from '../../components/AuthBackdrop';
import AuthField from '../../components/AuthField';
import AuthSubmitButton from '../../components/AuthSubmitButton';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

export default function LoginScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Backstop for the deliberate "keep spinning on success" below. Cleared on
  // unmount so the usual path — screen goes away — never fires it.
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (stuckTimer.current) clearTimeout(stuckTimer.current); }, []);

  async function handleLogin() {
    if (!email || !password) { setError(t('auth.fillAllFields')); return; }
    // Close the keyboard now that we are actually submitting — deliberately
    // AFTER the validation guard, so "fill in all fields" does not shut the
    // keyboard on someone who has to go straight back into a field.
    // It also uncovers the button: the spinner is no use behind a keyboard.
    Keyboard.dismiss();
    setLoading(true); setError('');
    // Capture a thrown network/timeout error into the same shape the branches
    // below already handle, so a rejected sign-in can never leave the button
    // stuck disabled — the setLoading(false) at the end always runs.
    let error: any;
    try {
      ({ error } = await supabase.auth.signInWithPassword({ email: email.trim(), password }));
    } catch (e: any) {
      error = e;
    }
    if (error) {
      if (/email not confirmed/i.test(error.message)) {
        // Their password is right but the address was never verified — send a
        // fresh confirmation email and take them to the code screen instead of
        // dead-ending on an error.
        supabase.auth.resend({ type: 'signup', email: email.trim() }).catch(() => {});
        router.push({ pathname: '/(auth)/verify-email', params: { email: email.trim() } });
      } else if (/invalid login credentials/i.test(error.message)) {
        setError(t('auth.invalidCredentials'));
      } else if (/rate|security purposes/i.test(error.message)) {
        setError(t('auth.rateLimited'));
      } else {
        setError(error.message);
      }
      // Every branch here leaves the user ON this screen — including the
      // verify-email push, which is a push and not a replace, so coming back
      // must not find a dead button.
      setLoading(false);
      return;
    }

    // SUCCESS — and deliberately do NOT stop the spinner.
    //
    // This is the "hitch that looks like it didn't work". Sign-in resolves in a
    // few hundred ms, but it does not navigate: the root auth listener in
    // app/_layout.tsx then fetches the profile, checks the account state and
    // only then routes to /(tabs) or /onboarding. Clearing loading here put the
    // button back to a normal, idle "Log in" for that whole ~2s window, so the
    // app looked like it had simply ignored the tap — a few people press it a
    // second time. The work is still running; the button should still say so.
    //
    // The screen unmounts when the route changes, which is what ends the
    // spinner on the happy path.
    stuckTimer.current = setTimeout(() => setLoading(false), 8000);
    // ...but not every post-login path navigates. A geo-blocked or deleted
    // account signs straight back out and lands here again, and an offline
    // profile fetch can hang. The timer is the guarantee that no route through
    // this function can leave a permanently spinning button — the property the
    // old unconditional setLoading(false) was protecting, kept.
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <AuthBackdrop />
      {/* A ScrollView, not a plain View, and the two keyboard props are the
          point of it — this screen had NEITHER, which is why the keyboard here
          never dismissed while sign-up (which has always had them) behaved.
            • keyboardShouldPersistTaps="handled" — a tap on empty space closes
              the keyboard, but a tap that a control handles still fires. Without
              it the first tap anywhere is swallowed just closing the keyboard.
            • keyboardDismissMode="on-drag" — dragging the form closes it too.
          Scrolling is a genuine second win: on a small screen with the keyboard
          up, the form no longer has nowhere to go. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoSection}>
          <AuthLogoMark size={72} />
          <View style={styles.logoWrap}>
            <Text style={styles.logo}>Laybell</Text>
            <Text style={styles.tm}>™</Text>
          </View>
          <Text style={styles.tagline}>{t('auth.tagline')}</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <AuthField
            icon="mail-outline"
            placeholder={t('auth.email')}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <AuthField
            icon="lock-closed-outline"
            placeholder={t('auth.password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            right={(
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={showPassword ? t('a11y.hidePassword') : t('a11y.showPassword')}
                onPress={() => setShowPassword(p => !p)}
              >
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textMeta} />
              </TouchableOpacity>
            )}
          />

          <AuthSubmitButton
            label={t('auth.login')}
            onPress={handleLogin}
            loading={loading}
            disabled={loading}
          />

          {/* Express sign-in — Google (and Apple where available). New accounts
              flow into onboarding automatically. */}
          <SocialAuthButtons onError={setError} />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.noAccount')}</Text>
          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity>
              <Text style={styles.linkText}>{t('auth.signUp')}</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  // flexGrow, not flex: on a ScrollView's contentContainer, flex:1 pins the
  // content to the viewport and kills scrolling. flexGrow keeps the form
  // vertically centred while it fits, and lets it scroll once it does not.
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xxl, gap: SPACING.sm },
  logo: { fontSize: 40, fontWeight: '800', color: colors.text, letterSpacing: 1 },
  // Wordmark + ™ tucked into the bottom-right corner — matches the home header
  // (app/(tabs)/index.tsx). Kept small and light so it reads as a discreet mark.
  logoWrap: { flexDirection: 'row', alignItems: 'flex-end' },
  tm: { fontSize: 11, fontWeight: '400', color: colors.primaryLight, marginLeft: 1, marginBottom: 5 },
  tagline: { fontSize: 14, color: colors.textSecondary },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },


  // White, not colors.text: the label sits on the gold end of the gradient in
  // both themes, so it must not follow the theme's text colour into black.

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
