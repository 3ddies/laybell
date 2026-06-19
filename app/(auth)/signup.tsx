import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { useState } from 'react';
import { Link, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

type Field = { icon: any; placeholder: string; value: string; onChange: (v: string) => void; secure?: boolean; keyboard?: any; capitalize?: any; maxLength?: number };

export default function SignupScreen() {
  const { colors } = useTheme();
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

  async function handleSignup() {
    // Ignore surrounding whitespace (e.g. a trailing space) on the username so it
    // never trips the length checks or the letters/numbers/underscores-only rule —
    // validate and submit the trimmed value.
    const uname = username.trim();
    if (!email || !password || !confirmPassword || !uname || !displayName) { setError('Please fill in all fields'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (uname.length < 5) { setError('Username must be at least 5 characters'); return; }
    if (uname.length > 30) { setError('Username must be 30 characters or less'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(uname)) { setError('Username can only contain letters, numbers, and underscores'); return; }
    if (!agreed) { setError('Please accept the Terms of Service and Privacy Policy to continue'); return; }

    setLoading(true); setError('');
    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { username: uname.toLowerCase(), display_name: displayName.trim() } },
    });
    if (signUpError) setError(signUpError.message);
    setLoading(false);
  }

  const fields: Field[] = [
    { icon: 'person-outline', placeholder: 'Display Name', value: displayName, onChange: setDisplayName },
    { icon: 'at-outline', placeholder: 'Username', value: username, onChange: setUsername, capitalize: 'none', maxLength: 30 },
    { icon: 'mail-outline', placeholder: 'Email', value: email, onChange: setEmail, capitalize: 'none', keyboard: 'email-address' },
    { icon: 'lock-closed-outline', placeholder: 'Password', value: password, onChange: setPassword, secure: true },
    { icon: 'lock-closed-outline', placeholder: 'Confirm Password', value: confirmPassword, onChange: setConfirmPassword, secure: true },
  ];

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        <View style={styles.logoSection}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.logoMark}>
            <Ionicons name="musical-notes" size={32} color={colors.text} />
          </LinearGradient>
          <Text style={styles.logo}>Laybell™</Text>
          <Text style={styles.tagline}>Join the movement.</Text>
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
                <TouchableOpacity onPress={() => setShowPass(p => !p)}>
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
              I confirm I'm at least 13 years old and agree to Laybell's{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/terms-of-service')}>Terms of Service</Text>
              {' '}and{' '}
              <Text style={styles.consentLink} onPress={() => router.push('/privacy-policy')}>Privacy Policy</Text>.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.button, (loading || !agreed) && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={loading || !agreed}
          >
            {loading ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>Create Account</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity><Text style={styles.linkText}>Log In</Text></TouchableOpacity>
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
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  logo: { fontSize: 36, fontWeight: '800', color: colors.text, letterSpacing: 1 },
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

  button: { backgroundColor: colors.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.md + 2, alignItems: 'center', marginTop: SPACING.sm },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm, marginTop: SPACING.xs },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, marginTop: 1,
    borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  consent: { flex: 1, color: colors.textTertiary, fontSize: 12, lineHeight: 18 },
  consentLink: { color: colors.primary, fontWeight: '700' },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerText: { color: colors.textSecondary, fontSize: 14 },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
});
