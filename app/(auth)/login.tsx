import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
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

  async function handleLogin() {
    if (!email || !password) { setError(t('auth.fillAllFields')); return; }
    setLoading(true); setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
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
    }
    setLoading(false);
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.inner}>
        {/* Logo */}
        <View style={styles.logoSection}>
          <Image source={require('../../assets/icon.png')} style={styles.logoMark} resizeMode="cover" />
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

          <View style={styles.inputWrap}>
            <Ionicons name="mail-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.email')}
              placeholderTextColor={colors.textTertiary}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
          </View>

          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.password')}
              placeholderTextColor={colors.textTertiary}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
            />
            <TouchableOpacity onPress={() => setShowPassword(p => !p)}>
              <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>{t('auth.login')}</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.noAccount')}</Text>
          <Link href="/(auth)/signup" asChild>
            <TouchableOpacity>
              <Text style={styles.linkText}>{t('auth.signUp')}</Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xxl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl },
  logo: { fontSize: 40, fontWeight: '800', color: colors.text, letterSpacing: 1 },
  // Wordmark + ™ tucked into the bottom-right corner — matches the home header
  // (app/(tabs)/index.tsx). Kept small and light so it reads as a discreet mark.
  logoWrap: { flexDirection: 'row', alignItems: 'flex-end' },
  tm: { fontSize: 11, fontWeight: '400', color: colors.primaryLight, marginLeft: 1, marginBottom: 5 },
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

  button: {
    backgroundColor: colors.primary, borderRadius: RADIUS.md,
    paddingVertical: SPACING.md + 2, alignItems: 'center', marginTop: SPACING.sm,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
